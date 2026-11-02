import { copyFile, rename, rm } from 'node:fs/promises';
import * as path from 'node:path';
import type { DbOperation, DbSnapshot, Draft, ProjectSnapshot, VariableMapRecord } from '../shared/types.ts';
import { JetBridge } from '../mdb/jet.ts';
import { encodeText, encodeUtf8, hasUtf8Bom } from '../util/encoding.ts';
import { pathExists, readBytes, removeFile, sha256, writeFileAtomic } from '../util/fsx.ts';
import { renameProjectInMgp } from './mgpParser.ts';
import { isInside, pathOutsideReason, physicalPath, samePhysicalPath } from './pathSafety.ts';
import { buildPlan } from './plan.ts';
import { openProject } from './session.ts';

export class SavePlanError extends Error {
  readonly diagnostics: unknown;

  constructor(message: string, diagnostics: unknown) {
    super(message);
    this.name = 'SavePlanError';
    this.diagnostics = diagnostics;
  }
}

export class SaveConflictError extends Error {
  readonly files: string[];

  constructor(message: string, files: string[]) {
    super(message);
    this.name = 'SaveConflictError';
    this.files = files;
  }
}

/** 保存失败且回滚没有完全恢复现场。消息中列出未恢复的路径。 */
export class SaveRollbackError extends Error {
  readonly rollbackErrors: string[];

  constructor(message: string, rollbackErrors: string[]) {
    super(message);
    this.name = 'SaveRollbackError';
    this.rollbackErrors = rollbackErrors;
  }
}

export interface SaveHooks {
  /** 测试用故障注入：源文件已写入后调用。 */
  afterProgramFiles?: () => void | Promise<void>;
  /** 测试用故障注入：数据库已提交后调用。 */
  afterDatabaseApply?: () => void | Promise<void>;
  /** 测试用故障注入：全部提交完成后、重新读取前调用。 */
  afterCommit?: () => void | Promise<void>;
  /** 测试用故障注入：进入回滚前调用（可制造回滚目标冲突）。 */
  beforeRollback?: () => void | Promise<void>;
}

export interface SaveOptions {
  snapshot: ProjectSnapshot;
  draft: Draft;
  bridge: JetBridge;
  /** 忽略外部修改冲突，强制以当前内存草稿覆盖。 */
  force?: boolean;
  /** 仅用于回归测试的故障注入点；正常调用不传。 */
  hooks?: SaveHooks;
}

export interface SaveResult {
  snapshot: ProjectSnapshot;
  warnings: string[];
  /** 提交成功但重新读取失败时的错误说明；此时 snapshot 是带警告的降级快照。 */
  refreshError?: string;
}

interface FileUndo {
  path: string;
  bytes: Uint8Array | null;
}

function fileKey(target: string): string {
  return target.replace(/\//g, '\\').toLowerCase();
}

async function assertNoConflicts(options: SaveOptions, fileWrites: Array<{ path: string; fromPath?: string; previousSha256?: string }>): Promise<void> {
  if (options.force) {
    return;
  }
  const changed: string[] = [];
  for (const stamp of options.snapshot.stamps) {
    const current = await pathExists(stamp.path);
    if (!current) {
      changed.push(`${stamp.path}（已被删除）`);
      continue;
    }
    const bytes = await readBytes(stamp.path).catch(() => undefined);
    if (!bytes || sha256(bytes) !== stamp.sha256) {
      changed.push(stamp.path);
    }
  }
  for (const write of fileWrites) {
    if (write.previousSha256 === undefined) {
      continue;
    }
    const checkPath = write.fromPath ?? write.path;
    const bytes = await readBytes(checkPath).catch(() => undefined);
    if (!bytes) {
      continue;
    }
    if (sha256(bytes) !== write.previousSha256) {
      changed.push(checkPath);
    }
  }
  if (changed.length > 0) {
    throw new SaveConflictError(
      `以下文件在打开工程后被外部修改，保存已取消：\n${[...new Set(changed)].join('\n')}`,
      [...new Set(changed)],
    );
  }
}

async function captureUndo(paths: string[]): Promise<FileUndo[]> {
  const seen = new Map<string, string>();
  for (const target of paths) {
    if (!target) {
      continue;
    }
    const key = fileKey(target);
    if (!seen.has(key)) {
      seen.set(key, target);
    }
  }
  const undo: FileUndo[] = [];
  for (const target of seen.values()) {
    const bytes = await readBytes(target).catch(() => undefined);
    undo.push({ path: target, bytes: bytes ?? null });
  }
  return undo;
}

async function restoreUndo(undo: FileUndo[], errors: string[]): Promise<void> {
  for (const entry of undo) {
    try {
      if (entry.bytes) {
        await writeFileAtomic(entry.path, entry.bytes);
      } else {
        await removeFile(entry.path);
      }
    } catch (error) {
      errors.push(`${entry.path}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function verifyApplied(before: DbSnapshot | undefined, after: DbSnapshot, ops: DbOperation[]): string[] {
  const problems: string[] = [];
  for (const op of ops) {
    switch (op.op) {
      case 'variable.insert': {
        if (!after.variables.some((variable) => variable.name === op.row.name)) {
          problems.push(`新增变量 ${op.row.name} 未出现在数据库中`);
        }
        break;
      }
      case 'variable.update': {
        const hit = after.variables.find((variable) => variable.id === op.id);
        if (!hit || hit.name !== op.row.name) {
          problems.push(`变量 #${op.id} 更新后名称不一致`);
        }
        break;
      }
      case 'variable.delete': {
        if (after.variables.some((variable) => variable.id === op.id)) {
          problems.push(`变量 #${op.id} 删除后仍然存在`);
        }
        break;
      }
      case 'program.insert': {
        if (!after.programs.some((program) => program.name === op.row.name)) {
          problems.push(`新增程序 ${op.row.name} 未出现在数据库中`);
        }
        break;
      }
      case 'program.update': {
        const hit = after.programs.find((program) => program.id === op.id);
        if (!hit || hit.name !== op.row.name) {
          problems.push(`程序 #${op.id} 更新后名称不一致`);
        }
        break;
      }
      case 'program.delete': {
        if (after.programs.some((program) => program.id === op.id)) {
          problems.push(`程序 #${op.id} 删除后仍然存在`);
        }
        break;
      }
      case 'channel.insert': {
        if (!after.channels.some((channel) => channel.id === op.row.id)) {
          problems.push(`新增通道 ${op.row.name} 未出现在数据库中`);
        }
        break;
      }
      case 'channel.update': {
        if (!after.channels.some((channel) => channel.id === op.id && channel.name === op.row.name)) {
          problems.push(`通道 #${op.id} 更新后名称不一致`);
        }
        break;
      }
      case 'channel.delete': {
        if (after.channels.some((channel) => channel.id === op.id)) {
          problems.push(`通道 #${op.id} 删除后仍然存在`);
        }
        break;
      }
      case 'device.insert': {
        if (!after.devices.some((device) => device.id === op.row.id)) {
          problems.push(`新增通讯设备 ${op.row.name} 未出现在数据库中`);
        }
        break;
      }
      case 'device.update': {
        if (!after.devices.some((device) => device.id === op.id && device.name === op.row.name)) {
          problems.push(`通讯设备 #${op.id} 更新后名称不一致`);
        }
        break;
      }
      case 'device.delete': {
        if (after.devices.some((device) => device.id === op.id)) {
          problems.push(`通讯设备 #${op.id} 删除后仍然存在`);
        }
        break;
      }
      case 'map.insert': {
        if (!after.maps.some((map) => map.id === op.row.id)) {
          problems.push(`新增变量映射 ${op.row.address} 未出现在数据库中`);
        }
        break;
      }
      case 'map.update': {
        if (!after.maps.some((map) => map.id === op.id && map.address === op.row.address)) {
          problems.push(`变量映射 #${op.id} 更新后地址不一致`);
        }
        break;
      }
      case 'map.delete': {
        if (after.maps.some((map) => map.id === op.id)) {
          problems.push(`变量映射 #${op.id} 删除后仍然存在`);
        }
        break;
      }
      default:
        break;
    }
  }
  if (before) {
    const removedUnexpectedly = before.variables.filter((variable) => {
      const stillThere = after.variables.find((item) => item.id === variable.id);
      return !stillThere && !ops.some((op) => op.op === 'variable.delete' && op.id === variable.id);
    });
    if (removedUnexpectedly.length > 0) {
      problems.push(`有 ${removedUnexpectedly.length} 个未在草稿中删除的变量消失了`);
    }
  }
  return problems;
}

function danglingMaps(snapshot: DbSnapshot): VariableMapRecord[] {
  return snapshot.maps.filter(
    (map) =>
      !snapshot.devices.some((device) => device.id === map.deviceId) ||
      !snapshot.variables.some((variable) => variable.id === map.symbolId),
  );
}

async function applyDatabase(
  snapshot: ProjectSnapshot,
  bridge: JetBridge,
  ops: DbOperation[],
  warnings: string[],
): Promise<boolean> {
  if (!snapshot.dbPath) {
    throw new SavePlanError('工程没有可写的设备数据库。', []);
  }
  const dbPath = snapshot.dbPath;
  const dir = path.dirname(dbPath);
  const baseline = new Set(
    (snapshot.db ? danglingMaps(snapshot.db) : []).map((map) => `${map.id}:${map.deviceId}:${map.symbolId}`),
  );
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const tempPath = path.join(dir, `.PrjLibrary.klp-tmp-${process.pid}-${Date.now()}-${attempt}.mdb`);
    let applied = false;
    try {
      await copyFile(dbPath, tempPath);
      const result = await bridge.apply(tempPath, ops);
      const problems = verifyApplied(snapshot.db, result.snapshot, ops);
      if (problems.length > 0) {
        throw new SavePlanError(`数据库写入后校验失败，已放弃写入：${problems.join('；')}`, problems);
      }
      const orphans = danglingMaps(result.snapshot);
      const newlyBroken = orphans.filter((map) => !baseline.has(`${map.id}:${map.deviceId}:${map.symbolId}`));
      if (newlyBroken.length > 0) {
        throw new SavePlanError(
          `数据库写入后会新增 ${newlyBroken.length} 条悬空通讯映射，已放弃写入：${newlyBroken
            .map((map) => `#${map.id}`)
            .join('、')}`,
          newlyBroken,
        );
      }
      await removeFile(tempPath.replace(/\.mdb$/i, '.ldb')).catch(() => undefined);
      await rename(tempPath, dbPath);
      applied = true;
      if (orphans.length > 0) {
        warnings.push(`保存后仍有 ${orphans.length} 条悬空通讯映射（均为保存前已存在，插件未自动清理）。`);
      }
      return true;
    } catch (error) {
      lastError = error;
      if (!applied) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        await removeFile(tempPath.replace(/\.mdb$/i, '.ldb')).catch(() => undefined);
      }
      const retryable =
        error instanceof Error && /Not a valid password|Unable to open database/i.test(error.message);
      if (!retryable || attempt === 3) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

function encodeProgramWrite(write: NonNullable<ReturnType<typeof buildPlan>['programWrites'][number]>): Uint8Array {
  if (write.text.includes('\uFFFD')) {
    throw new SavePlanError(`源文件文本含无法解码的替换字符，拒绝写回：${write.path}`, []);
  }
  if (write.bom && write.encoding === 'utf-8') {
    const body = encodeUtf8(write.text);
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf], 0);
    out.set(body, 3);
    return out;
  }
  return encodeText(write.text, write.encoding);
}

async function applyProgramFiles(
  writes: NonNullable<ReturnType<typeof buildPlan>['programWrites']>,
  moves: ReturnType<typeof buildPlan>['programMoves'],
  deletes: ReturnType<typeof buildPlan>['programDeletes'],
): Promise<void> {
  const targets = new Set(writes.map((write) => fileKey(write.path)));
  for (const write of writes) {
    if (!write.path) {
      continue;
    }
    await writeFileAtomic(write.path, encodeProgramWrite(write));
  }
  for (const move of moves) {
    if (!move.fromPath || !move.toPath) {
      continue;
    }
    if (fileKey(move.fromPath) === fileKey(move.toPath)) {
      continue;
    }
    if (targets.has(fileKey(move.fromPath))) {
      continue;
    }
    await removeFile(move.fromPath);
  }
  for (const item of deletes) {
    if (!item.path) {
      continue;
    }
    if (targets.has(fileKey(item.path))) {
      continue;
    }
    await removeFile(item.path);
  }
}

async function assertPathsSafe(snapshot: ProjectSnapshot, plan: ReturnType<typeof buildPlan>): Promise<void> {
  let root: string;
  let currentRoot: string;
  try {
    root = snapshot.physicalRoot ?? (await physicalPath(snapshot.projectDir));
    currentRoot = await physicalPath(snapshot.projectDir);
  } catch (error) {
    throw new SavePlanError(
      `工程物理路径无法验证，已阻止保存：${error instanceof Error ? error.message : String(error)}`,
      [],
    );
  }
  if (plan.projectRename) {
    // 只有“根目录自身是链接”才不能整体改名；祖先目录是 junction/subst 时，
    // realpath(根目录) 仍等于 realpath(父目录)+basename，应允许合法改名。
    const parentPhysical = await physicalPath(path.dirname(snapshot.projectDir));
    const expectedRoot = path.join(parentPhysical, path.basename(snapshot.projectDir));
    if (!samePhysicalPath(root, expectedRoot)) {
      throw new SavePlanError(
        `工程根目录本身是 junction/symlink（${snapshot.projectDir} -> ${root}）。重命名只会移动链接而不会移动真实工程目录，已阻止保存。`,
        [],
      );
    }
  }
  if (!(isInside(root, currentRoot) && isInside(currentRoot, root))) {
    throw new SavePlanError(
      `工程根目录的物理位置在打开后发生变化：${snapshot.projectDir} -> ${currentRoot}（打开时为 ${root}），已阻止保存。`,
      [],
    );
  }
  const targets: Array<[string | undefined, string]> = [
    [snapshot.entryPath, '工程入口'],
    [snapshot.dbPath, '设备数据库'],
  ];
  for (const write of plan.programWrites) {
    targets.push([write.path, '程序目标文件']);
    targets.push([write.fromPath, '程序来源文件']);
  }
  for (const move of plan.programMoves) {
    targets.push([move.fromPath, '程序旧文件'], [move.toPath, '程序新文件']);
  }
  for (const item of plan.programDeletes) {
    targets.push([item.path, '程序删除文件']);
  }
  for (const [target, label] of targets) {
    if (!target) {
      continue;
    }
    const reason = await pathOutsideReason(root, target, label);
    if (reason) {
      throw new SavePlanError(`${reason}。已阻止保存。`, []);
    }
  }
}

async function assertProgramTargetFiles(plan: ReturnType<typeof buildPlan>): Promise<void> {
  const removed = new Set(
    [...plan.programMoves.map((move) => move.fromPath), ...plan.programDeletes.map((item) => item.path)]
      .filter(Boolean)
      .map((item) => item.toLowerCase()),
  );
  for (const write of plan.programWrites) {
    if (!write.path) {
      continue;
    }
    const key = write.path.toLowerCase();
    if (write.fromPath && write.fromPath.toLowerCase() === key) {
      continue;
    }
    if (removed.has(key)) {
      continue;
    }
    if (!(await pathExists(write.path))) {
      continue;
    }
    throw new SavePlanError(
      `目标源文件已存在且不属于本次草稿要移走的程序：${write.path}。为避免覆盖未注册文件，已阻止保存。`,
      [],
    );
  }
}

async function assertRenameTargets(plan: NonNullable<ReturnType<typeof buildPlan>['projectRename']>): Promise<void> {
  if (await pathExists(plan.toDir)) {
    throw new SavePlanError(`目标目录已存在：${plan.toDir}`, []);
  }
  if (await pathExists(plan.toEntry)) {
    throw new SavePlanError(`目标入口文件已存在：${plan.toEntry}`, []);
  }
}

async function renameProject(
  plan: NonNullable<ReturnType<typeof buildPlan>['projectRename']>,
): Promise<string> {
  const originalBytes = await readBytes(plan.fromEntry);
  const hadBom = hasUtf8Bom(originalBytes);
  const xml = new TextDecoder('utf-8').decode(hadBom ? originalBytes.subarray(3) : originalBytes);
  const renamed = renameProjectInMgp(xml, plan.newName);
  const renamedBytes = hadBom ? (() => {
    const body = encodeUtf8(renamed);
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf], 0);
    out.set(body, 3);
    return out;
  })() : encodeUtf8(renamed);
  await writeFileAtomic(plan.fromEntry, renamedBytes);
  try {
    await rename(plan.fromEntry, plan.toEntry);
  } catch (error) {
    await writeFileAtomic(plan.fromEntry, originalBytes).catch(() => undefined);
    throw error;
  }
  try {
    await rename(plan.fromDir, plan.toDir);
  } catch (error) {
    await rename(plan.toEntry, plan.fromEntry).catch(() => undefined);
    await writeFileAtomic(plan.fromEntry, originalBytes).catch(() => undefined);
    throw error;
  }
  return path.join(plan.toDir, path.basename(plan.toEntry));
}

async function rollbackSave(
  snapshot: ProjectSnapshot,
  plan: ReturnType<typeof buildPlan>,
  undo: FileUndo[],
  dbOriginal: Uint8Array | undefined,
  errors: string[],
): Promise<void> {
  const projectRename = plan.projectRename;
  let canRestore = true;
  if (projectRename) {
    const fromDir = projectRename.fromDir;
    const toDir = projectRename.toDir;
    const fromExists = await pathExists(fromDir);
    const toExists = await pathExists(toDir);
    if (toExists && !fromExists) {
      try {
        await rename(toDir, fromDir);
      } catch (error) {
        canRestore = false;
        errors.push(`工程目录回滚失败，现场保留在：${toDir}：${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (toExists && fromExists) {
      canRestore = false;
      errors.push(`工程目录回滚目标冲突：原目录与目标目录同时存在（${fromDir} / ${toDir}），未继续写入旧路径。`);
    }
    if (canRestore) {
      const movedEntry = path.join(fromDir, path.basename(projectRename.toEntry));
      if (!(await pathExists(projectRename.fromEntry)) && (await pathExists(movedEntry))) {
        try {
          await rename(movedEntry, projectRename.fromEntry);
        } catch (error) {
          canRestore = false;
          errors.push(`工程入口回滚失败，现场保留在：${movedEntry}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  if (!canRestore) {
    // 目录/入口未恢复时，不能再按旧路径 restoreUndo；writeFileAtomic 会 mkdir，
    // 造出半套旧目录，掩盖真正的现场。保留可恢复文件并报告实际路径。
    if (dbOriginal && snapshot.dbPath) {
      errors.push(`数据库改动未回滚，现场保留在目标目录中的 PrjLibrary.mdb（原路径 ${snapshot.dbPath}）`);
    }
    if (undo.length > 0) {
      errors.push(`源码/入口改动未回滚，现场保留在目标目录中的 ${undo.length} 个文件（旧路径不可用）`);
    }
    return;
  }
  if (snapshot.dbPath && dbOriginal) {
    try {
      await writeFileAtomic(snapshot.dbPath, dbOriginal);
    } catch (error) {
      errors.push(`数据库回滚失败：${snapshot.dbPath}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await restoreUndo(undo, errors);
}

function rebasePath(fromDir: string, toDir: string, target: string | undefined): string | undefined {
  if (!target || fromDir.toLowerCase() === toDir.toLowerCase()) {
    return target;
  }
  const relative = path.relative(fromDir, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return target;
  }
  return path.join(toDir, relative);
}

function fallbackSnapshot(
  snapshot: ProjectSnapshot,
  plan: ReturnType<typeof buildPlan>,
  entryAfter: string,
  message: string,
): ProjectSnapshot {
  const projectRename = plan.projectRename;
  const fromDir = snapshot.projectDir;
  const toDir = projectRename?.toDir ?? snapshot.projectDir;
  const rebase = (target: string | undefined): string | undefined => rebasePath(fromDir, toDir, target);
  return {
    ...snapshot,
    entryPath: entryAfter,
    projectDir: toDir,
    project: {
      ...snapshot.project,
      name: projectRename?.newName ?? snapshot.project.name,
    },
    // 重新读取失败时数据库内容未知；宁可禁用编辑，也不要用旧快照继续写入。
    db: undefined,
    dbPath: undefined,
    devices: snapshot.devices.map((device) => ({
      ...device,
      dataDirPath: rebase(device.dataDirPath),
      resourcePath: rebase(device.resourcePath),
      dbPath: rebase(device.dbPath),
      programs: device.programs.map((program) => ({ ...program, path: rebase(program.path) })),
    })),
    stamps: [],
    diagnostics: [
      ...snapshot.diagnostics,
      {
        severity: 'warning',
        code: 'project.reloadFailed',
        message: `保存已提交，但重新读取工程失败：${message}。当前显示可能不是最新状态，请执行“重新读取工程”。`,
      },
    ],
  };
}

async function openProjectWithRetry(entryPath: string, bridge: JetBridge): Promise<ProjectSnapshot> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await openProject(entryPath, bridge);
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

export async function saveProject(options: SaveOptions): Promise<SaveResult> {
  const { snapshot, draft, bridge, hooks } = options;
  const plan = buildPlan({ snapshot, draft });
  if (!plan.canSave) {
    const errors = plan.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    throw new SavePlanError(errors.map((item) => item.message).join('\n') || '没有可以保存的修改。', plan.diagnostics);
  }
  await assertPathsSafe(snapshot, plan);
  await assertProgramTargetFiles(plan);
  await assertNoConflicts(options, plan.programWrites);
  if (plan.projectRename) {
    await assertRenameTargets(plan.projectRename);
  }

  const warnings: string[] = [];
  const undoPaths = [
    ...plan.programWrites.map((write) => write.path),
    ...plan.programMoves.flatMap((move) => [move.fromPath, move.toPath]),
    ...plan.programDeletes.map((item) => item.path),
    snapshot.entryPath,
  ].filter(Boolean);
  const undo = await captureUndo(undoPaths);
  // 没有数据库操作时不要回写 .mdb：既无必要，也会在 KLP 占用数据库时制造
  // 一个与本次保存无关的“回滚不完整”错误。
  const dbOriginal = plan.dbOps.length > 0 && snapshot.dbPath ? await readBytes(snapshot.dbPath) : undefined;
  let dbCommitted = false;
  let entryAfter = snapshot.entryPath;

  try {
    await applyProgramFiles(plan.programWrites, plan.programMoves, plan.programDeletes);
    await hooks?.afterProgramFiles?.();
    if (plan.dbOps.length > 0) {
      dbCommitted = await applyDatabase(snapshot, bridge, plan.dbOps, warnings);
    }
    await hooks?.afterDatabaseApply?.();
    if (plan.projectRename) {
      entryAfter = await renameProject(plan.projectRename);
    }
    await hooks?.afterCommit?.();
  } catch (error) {
    const rollbackErrors: string[] = [];
    await hooks?.beforeRollback?.();
    await rollbackSave(snapshot, plan, undo, dbCommitted ? dbOriginal : undefined, rollbackErrors);
    if (rollbackErrors.length > 0) {
      throw new SaveRollbackError(
        `保存失败，且回滚没有完全恢复：${rollbackErrors.join('；')}。原始错误：${error instanceof Error ? error.message : String(error)}`,
        rollbackErrors,
      );
    }
    throw error;
  }

  let refreshed: ProjectSnapshot;
  let refreshError: string | undefined;
  try {
    refreshed = await openProjectWithRetry(entryAfter, bridge);
  } catch (error) {
    refreshError = error instanceof Error ? error.message : String(error);
    refreshed = fallbackSnapshot(snapshot, plan, entryAfter, refreshError);
  }
  if (refreshError) {
    warnings.push(`保存已提交，但重新读取工程失败：${refreshError}。请执行“重新读取工程”确认最新状态。`);
  }
  return { snapshot: refreshed, warnings, refreshError };
}
