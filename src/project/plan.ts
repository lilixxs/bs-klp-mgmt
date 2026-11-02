import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type {
  ChannelRecord,
  ChannelRow,
  CommDeviceRecord,
  DbOperation,
  DeviceRow,
  Diagnostic,
  Draft,
  DraftOp,
  DraftPlan,
  EffectiveState,
  EntityRef,
  MapRow,
  ProgramRecord,
  ProgramRow,
  ProjectSnapshot,
  VariableMapRecord,
  VariableRecord,
  VariableRow,
} from '../shared/types.ts';
import { validateFreeTextName, validateIdentifier, validateProjectName } from '../shared/validation.ts';
import { dbDeviceLayout } from './session.ts';
import { findIdentifierUsages, replaceIdentifier, setProgramHeaderName } from './st.ts';

export interface PlanInput {
  snapshot: ProjectSnapshot;
  draft: Draft;
}

interface ProgramState extends ProgramRecord {
  sourcePath?: string;
  sourceText: string;
  encoding: 'gbk' | 'utf-8';
  bom: boolean;
  lossy: boolean;
  missing: boolean;
  sourceSha256?: string;
  tempId?: string;
}

interface VariableState extends VariableRecord {
  tempId?: string;
}

interface ChannelState extends ChannelRecord {
  tempId?: string;
}

interface DeviceState extends CommDeviceRecord {
  channelRef: EntityRef;
  tempId?: string;
}

interface MapState extends VariableMapRecord {
  deviceRef: EntityRef;
  symbolRef: EntityRef;
  tempId?: string;
}

interface WorkingState {
  variables: VariableState[];
  programs: ProgramState[];
  channels: ChannelState[];
  devices: DeviceState[];
  maps: MapState[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nextOrder(items: Array<{ order: number }>): number {
  return items.reduce((max, item) => Math.max(max, item.order), 0) + 1;
}

function findType(snapshot: ProjectSnapshot, defTypeId: number): { crc: number; stringSize: number } | undefined {
  return snapshot.db?.definitionTypes.find((type) => type.id === defTypeId);
}

function stLanguageId(snapshot: ProjectSnapshot): number | undefined {
  return snapshot.db?.languages.find((language) => language.name.toUpperCase() === 'ST')?.id;
}

function primaryLayout(snapshot: ProjectSnapshot) {
  return dbDeviceLayout(snapshot) ?? snapshot.devices.find((device) => device.resourcePath) ?? snapshot.devices[0];
}

function programSourceFor(
  snapshot: ProjectSnapshot,
  program: ProgramRecord,
): { sourcePath?: string; sourceText: string; encoding: 'gbk' | 'utf-8'; bom: boolean; lossy: boolean; missing: boolean; sourceSha256?: string } {
  const layout = primaryLayout(snapshot);
  const index = snapshot.db?.programs.findIndex((item) => item.id === program.id) ?? -1;
  const byIndex = index >= 0 ? layout?.programs[index] : undefined;
  const byName = layout?.programs[snapshot.db?.programs.findIndex((item) => item.name.toLowerCase() === program.name.toLowerCase()) ?? -1];
  const source = byIndex ?? byName;
  if (!source) {
    return { sourceText: '', encoding: 'gbk', bom: false, lossy: false, missing: true };
  }
  return {
    sourcePath: source.path,
    sourceText: source.text ?? '',
    encoding: source.encoding,
    bom: source.bom ?? false,
    lossy: source.lossy ?? false,
    missing: source.missing,
    sourceSha256: source.sha256,
  };
}

export function buildWorkingState(snapshot: ProjectSnapshot): WorkingState {
  const db = snapshot.db;
  if (!db) {
    return { variables: [], programs: [], channels: [], devices: [], maps: [] };
  }
  const programs = db.programs.map((program) => {
    const source = programSourceFor(snapshot, program);
    return {
      ...program,
      sourcePath: source.sourcePath,
      sourceText: source.sourceText,
      encoding: source.encoding,
      bom: source.bom,
      lossy: source.lossy,
      missing: source.missing,
      sourceSha256: source.sourceSha256,
    } satisfies ProgramState;
  });
  return {
    variables: clone(db.variables) as VariableState[],
    programs,
    channels: clone(db.channels) as ChannelState[],
    devices: clone(db.devices).map((device) => ({
      ...device,
      channelRef: { kind: 'existing', id: device.channelId } satisfies EntityRef,
    })),
    maps: clone(db.maps).map((map) => ({
      ...map,
      deviceRef: { kind: 'existing', id: map.deviceId } satisfies EntityRef,
      symbolRef: { kind: 'existing', id: map.symbolId } satisfies EntityRef,
    })),
  };
}

function normalizeName(value: string): string {
  return value.trim();
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function buildPlan(input: PlanInput): DraftPlan {
  const { snapshot, draft } = input;
  const diagnostics: Diagnostic[] = [];
  const summary: string[] = [];
  const dbOps: DbOperation[] = [];
  const programWrites: Array<DraftPlan['programWrites'][number] | undefined> = [];
  const programMoves: DraftPlan['programMoves'] = [];
  const programDeletes: DraftPlan['programDeletes'] = [];
  const state = buildWorkingState(snapshot);
  const db = snapshot.db;

  if (!db) {
    diagnostics.push({
      severity: 'error',
      code: 'plan.noDb',
      message: '数据库未读取，无法编辑任何对象。请先解决数据库访问问题。',
    });
    return {
      diagnostics,
      canSave: false,
      summary,
      programWrites: [],
      programMoves,
      programDeletes,
      dbOps,
      effective: { variables: [], programs: [], channels: [], devices: [], maps: [] },
    };
  }

  if (snapshot.pathSafety && !snapshot.pathSafety.writable) {
    diagnostics.push({
      severity: 'error',
      code: 'path.outsideProject',
      message:
        snapshot.pathSafety.message ??
        '工程中有数据路径的物理位置越出工程根目录（可能是 junction/symlink），已禁止保存。',
    });
  }

  const stId = stLanguageId(snapshot);
  const deletedVariables = new Set<number>();
  const deletedPrograms = new Set<number>();
  const deletedChannels = new Set<number>();
  const deletedDevices = new Set<number>();
  const deletedMaps = new Set<number>();
  const newVariableIds = new Set<string>();
  const newProgramIds = new Set<string>();
  const newChannelIds = new Set<string>();
  const newDeviceIds = new Set<string>();
  const newMapIds = new Set<string>();
  const variableOrder = { next: nextOrder(state.variables) };
  const programOrder = { next: nextOrder(state.programs) };
  let channelNextId = state.channels.reduce((max, item) => Math.max(max, item.id), 0) + 1;
  let deviceNextId = state.devices.reduce((max, item) => Math.max(max, item.id), 0) + 1;
  let mapNextId = state.maps.reduce((max, item) => Math.max(max, item.id), 0) + 1;
  let newDisplayId = -1;
  const takeDisplayId = (): number => {
    const id = newDisplayId;
    newDisplayId -= 1;
    return id;
  };

  const rejectPendingNew = (label: string, id: number, kind: string): boolean => {
    if (id >= 0) {
      return false;
    }
    diagnostics.push({
      severity: 'error',
      code: 'object.pendingInsert',
      message: `${label}：${kind}尚未保存，不能在同一草稿中继续修改或删除；请先保存新增对象。`,
    });
    return true;
  };

  const variableById = (id: number): VariableState | undefined => state.variables.find((item) => item.id === id);
  const programById = (id: number): ProgramState | undefined => state.programs.find((item) => item.id === id);
  const channelById = (id: number): ChannelState | undefined => state.channels.find((item) => item.id === id);
  const deviceById = (id: number): DeviceState | undefined => state.devices.find((item) => item.id === id);
  const mapById = (id: number): MapState | undefined => state.maps.find((item) => item.id === id);

  const usedProgramNames = new Set((db.pous ?? []).map((pou) => pou.name.toLowerCase()));
  const usedVariableNames = new Set(state.variables.map((variable) => variable.name.toLowerCase()));

  const writeIndex = new Map<string, number>();
  const scheduleProgramWrite = (write: NonNullable<DraftPlan['programWrites'][number]>): void => {
    const key = write.path.toLowerCase();
    const existing = writeIndex.get(key);
    if (existing !== undefined) {
      const previous = programWrites[existing];
      // 后续（例如变量改名）只能更新文本，不能洗掉“这是新增/改名目标”的来源信息。
      // fromPath 为空始终表示目标文件必须不存在；若被覆盖成 path，未注册文件会被当成原地更新。
      programWrites[existing] = {
        ...previous,
        ...write,
        fromPath: previous?.fromPath,
        previousSha256: write.previousSha256 ?? previous?.previousSha256,
        bom: write.bom ?? previous?.bom,
      };
      return;
    }
    writeIndex.set(key, programWrites.length);
    programWrites.push(write);
  };
  const moveProgramWrite = (fromPath: string, toPath: string): void => {
    const fromKey = fromPath.toLowerCase();
    const index = writeIndex.get(fromKey);
    if (index === undefined) {
      return;
    }
    writeIndex.delete(fromKey);
    const write = programWrites[index];
    if (!write) {
      return;
    }
    const moved = { ...write, path: toPath, fromPath };
    programWrites[index] = moved;
    writeIndex.set(toPath.toLowerCase(), index);
  };
  const cancelProgramWrite = (target: string): void => {
    const key = target.toLowerCase();
    const index = writeIndex.get(key);
    if (index !== undefined) {
      programWrites[index] = undefined;
      writeIndex.delete(key);
    }
  };

  const initialDangling = new Set(
    db.maps
      .filter(
        (map) =>
          !db.variables.some((variable) => variable.id === map.symbolId) ||
          !db.devices.some((device) => device.id === map.deviceId),
      )
      .map((map) => map.id),
  );
  const initialDanglingDevices = new Set(
    db.devices.filter((device) => !db.channels.some((channel) => channel.id === device.channelId)).map((device) => device.id),
  );

  const projectRename = planProjectRename(snapshot, draft, diagnostics);

  for (const [index, op] of draft.ops.entries()) {
    const label = `第 ${index + 1} 项修改`;
    switch (op.kind) {
      case 'variable.add': {
        const input = normalizeVariableInput(op.input);
        const issue = validateVariable(snapshot, input, undefined, usedVariableNames, usedProgramNames);
        if (issue) {
          diagnostics.push({ severity: 'error', code: issue.code, message: `${label}：${issue.message}` });
          break;
        }
        const template = pickVariableTemplate(state.variables, input);
        const type = findType(snapshot, input.defTypeId);
        const row: VariableRow = {
          name: input.name,
          comment: input.comment,
          alias: '',
          varInstanceId: input.varInstanceId,
          resourcePouId: input.resourcePouId,
          scopeId: input.scopeId,
          defTypeId: input.defTypeId,
          stringSize: template?.stringSize ?? type?.stringSize ?? 0,
          attributeId: input.attributeId,
          directionId: input.directionId,
          groupId: input.groupId,
          userAddress: input.userAddress,
          wiring: input.wiring,
          isRetain: input.isRetain,
          order: variableOrder.next,
          hasDimension: template?.hasDimension ?? false,
          initialValue: input.initialValue,
          refLibrary: template?.refLibrary ?? null,
          hook: template?.hook ?? null,
          crcInitValueDim: template?.crcInitValueDim ?? 1,
          crcInitValueType: type?.crc ?? 0,
          status: template?.status ?? null,
        };
        variableOrder.next += 1;
        usedVariableNames.add(input.name.toLowerCase());
        newVariableIds.add(op.tempId);
        dbOps.push({ op: 'variable.insert', tempId: op.tempId, row });
        state.variables.push({ ...toVariableRecord(takeDisplayId(), row), tempId: op.tempId });
        summary.push(`新增变量 ${input.name}`);
        break;
      }
      case 'variable.update': {
        if (rejectPendingNew(label, op.id, '变量')) {
          break;
        }
        const current = variableById(op.id);
        if (!current) {
          diagnostics.push({ severity: 'error', code: 'variable.missing', message: `${label}：变量 #${op.id} 不存在。` });
          break;
        }
        const input = normalizeVariableInput(op.input);
        const issue = validateVariable(snapshot, input, op.id, usedVariableNames, usedProgramNames, current.name);
        if (issue) {
          diagnostics.push({ severity: 'error', code: issue.code, message: `${label}：${issue.message}` });
          break;
        }
        if (current.name !== input.name && sameName(current.name, input.name)) {
          diagnostics.push({
            severity: 'error',
            code: 'variable.caseOnlyRename',
            message: `${label}：当前版本不支持仅改变大小写的变量改名（${current.name} → ${input.name}）。请使用实际不同的名称，避免数据库与源码大小写分叉。`,
          });
          break;
        }
        const type = findType(snapshot, input.defTypeId);
        const renamed = !sameName(current.name, input.name);
        const references = renamed ? collectVariableReferences(snapshot, state, current.name) : { usages: [], programNames: [] };
        if (renamed) {
          const unsafePrograms = state.programs.filter(
            (program) => program.missing || program.lossy || !program.sourcePath,
          );
          if (unsafePrograms.length > 0) {
            diagnostics.push({
              severity: 'error',
              code: 'variable.renameBlockedSource',
              message: `${label}：以下程序源文件缺失或含无法解码字节，插件无法确认引用完整性，不能重命名变量：${unsafePrograms
                .map((program) => program.name)
                .join('、')}。`,
            });
            break;
          }
          const nonStReferences = references.usages.filter((usage) => {
            const program = state.programs.find((item) => item.name.toLowerCase() === usage.program.toLowerCase());
            return program && program.languageId !== stId;
          });
          if (nonStReferences.length > 0) {
            const programs = [...new Set(nonStReferences.map((usage) => usage.program))].join('、');
            diagnostics.push({
              severity: 'error',
              code: 'variable.renameBlockedNonSt',
              message: `${label}：变量 ${current.name} 仍被非 ST 程序 ${programs} 引用，插件无法安全改写该程序，不能重命名。`,
            });
            break;
          }
        }
        if (renamed && references.usages.length > 0) {
          summary.push(`重命名变量 ${current.name} → ${input.name}，同步更新 ${references.usages.length} 处源码引用`);
        } else if (renamed) {
          summary.push(`重命名变量 ${current.name} → ${input.name}`);
        } else {
          summary.push(`修改变量 ${input.name}`);
        }
        if (renamed) {
          usedVariableNames.delete(current.name.toLowerCase());
          usedVariableNames.add(input.name.toLowerCase());
          for (const program of state.programs) {
            if (program.languageId !== stId || program.missing || !program.sourcePath || !program.sourcePath.toLowerCase().endsWith('.stf')) {
              continue;
            }
            if (!program.sourceText || program.sourceText.length === 0) {
              continue;
            }
            const result = replaceInProgramText(program.sourceText, current.name, input.name);
            if (result.count > 0) {
              program.sourceText = result.text;
              scheduleProgramWrite({
                path: program.sourcePath,
                fromPath: program.sourcePath,
                text: result.text,
                encoding: program.encoding,
                previousSha256: program.sourceSha256,
                bom: program.bom,
              });
            }
          }
        }
        const typeChanged = current.defTypeId !== input.defTypeId;
        const row: VariableRow = {
          name: input.name,
          comment: input.comment,
          alias: current.alias,
          varInstanceId: input.varInstanceId,
          resourcePouId: input.resourcePouId,
          scopeId: input.scopeId,
          defTypeId: input.defTypeId,
          stringSize: typeChanged ? (type?.stringSize ?? current.stringSize) : current.stringSize,
          attributeId: input.attributeId,
          directionId: input.directionId,
          groupId: input.groupId,
          userAddress: input.userAddress,
          wiring: input.wiring,
          isRetain: input.isRetain,
          order: current.order,
          hasDimension: current.hasDimension,
          initialValue: input.initialValue,
          refLibrary: current.refLibrary,
          hook: current.hook,
          crcInitValueDim: current.crcInitValueDim,
          crcInitValueType: typeChanged ? (type?.crc ?? current.crcInitValueType) : current.crcInitValueType,
          status: current.status,
        };
        dbOps.push({ op: 'variable.update', id: op.id, row });
        Object.assign(current, toVariableRecord(op.id, row));
        break;
      }
      case 'variable.delete': {
        if (rejectPendingNew(label, op.id, '变量')) {
          break;
        }
        const current = variableById(op.id);
        if (!current) {
          diagnostics.push({ severity: 'error', code: 'variable.missing', message: `${label}：变量 #${op.id} 不存在。` });
          break;
        }
        const unsafePrograms = state.programs.filter(
          (program) => program.missing || program.lossy || !program.sourcePath,
        );
        if (unsafePrograms.length > 0) {
          diagnostics.push({
            severity: 'error',
            code: 'variable.deleteBlockedSource',
            message: `${label}：以下程序源文件缺失或含无法解码字节，插件无法确认变量是否仍被引用，不能删除变量：${unsafePrograms
              .map((program) => program.name)
              .join('、')}。`,
          });
          break;
        }
        const reason = describeVariableDeletionBlock(snapshot, state, current, deletedMaps);
        if (reason) {
          diagnostics.push({ severity: 'error', code: 'variable.deleteBlocked', message: `${label}：${reason}` });
          break;
        }
        deletedVariables.add(op.id);
        dbOps.push({ op: 'variable.delete', id: op.id });
        state.variables = state.variables.filter((item) => item.id !== op.id);
        if (current.tempId) {
          newVariableIds.delete(current.tempId);
        }
        usedVariableNames.delete(current.name.toLowerCase());
        summary.push(`删除变量 ${current.name}`);
        break;
      }
      case 'program.add': {
        const input = normalizeProgramInput(op.input);
        const issue = validateProgram(snapshot, input, undefined, usedProgramNames, usedVariableNames, stId);
        if (issue) {
          diagnostics.push({ severity: 'error', code: issue.code, message: `${label}：${issue.message}` });
          break;
        }
        const layout = primaryLayout(snapshot);
        if (!layout?.resourcePath) {
          diagnostics.push({ severity: 'error', code: 'program.dirMissing', message: `${label}：无法定位程序目录，不能新增程序。` });
          break;
        }
        if (layout.resourceId !== undefined && input.resourceId !== layout.resourceId) {
          diagnostics.push({
            severity: 'error',
            code: 'program.resourceUnsupported',
            message: `${label}：当前版本只支持数据库首个资源目录（#${layout.resourceId}），不能把程序写入资源 #${input.resourceId}。`,
          });
          break;
        }
        const targetPath = path.join(layout.resourcePath, `${input.name}.stf`);
        const text = ensureProgramText(input.name, input.sourceText ?? '');
        const template =
          state.programs.find(
            (program) => program.languageId === input.languageId && program.resourceId === input.resourceId,
          ) ?? state.programs.find((program) => program.languageId === input.languageId);
        if (!template) {
          diagnostics.push({
            severity: 'error',
            code: 'program.templateMissing',
            message: `${label}：资源 #${input.resourceId} 中没有可克隆的现有 ST 程序。缺少 RefLocalization 等 KLP 字段的正确值，无法安全新增程序；请先在 KLP 中创建或保留一个 ST 程序。`,
          });
          break;
        }
        const row: ProgramRow = {
          name: input.name,
          comment: input.comment,
          languageId: input.languageId,
          resourceId: input.resourceId,
          order: programOrder.next,
          readOnly: false,
          generateSymbMon: true,
          refLocalization: template?.refLocalization ?? 0,
          refPouGroup: template?.refPouGroup ?? 0,
          generateDebugInfo: template?.generateDebugInfo ?? false,
          is1499: template?.is1499 ?? false,
        };
        programOrder.next += 1;
        usedProgramNames.add(input.name.toLowerCase());
        newProgramIds.add(op.tempId);
        dbOps.push({ op: 'program.insert', tempId: op.tempId, row });
        scheduleProgramWrite({ path: targetPath, text, encoding: 'gbk', bom: false });
        state.programs.push({
          id: takeDisplayId(),
          tempId: op.tempId,
          name: input.name,
          comment: input.comment,
          languageId: input.languageId,
          resourceId: input.resourceId,
          order: row.order,
          fatherId: 0,
          readOnly: false,
          generateSymbMon: true,
          encrypted: false,
          refLocalization: row.refLocalization,
          refPouGroup: row.refPouGroup,
          generateDebugInfo: row.generateDebugInfo,
          is1499: row.is1499,
          hasProgramRow: true,
          sourcePath: targetPath,
          sourceText: text,
          encoding: 'gbk',
          bom: false,
          lossy: false,
          missing: false,
        });
        summary.push(`新增 ST 程序 ${input.name}`);
        break;
      }
      case 'program.update': {
        if (rejectPendingNew(label, op.id, '程序')) {
          break;
        }
        const current = programById(op.id);
        if (!current) {
          diagnostics.push({ severity: 'error', code: 'program.missing', message: `${label}：程序 #${op.id} 不存在。` });
          break;
        }
        const input = normalizeProgramInput(op.input);
        if (current.languageId !== stId) {
          diagnostics.push({
            severity: 'error',
            code: 'program.notSt',
            message: `${label}：程序 ${current.name} 不是 ST 语言，插件禁止写入。`,
          });
          break;
        }
        if (!current.hasProgramRow) {
          diagnostics.push({
            severity: 'error',
            code: 'program.rowMissing',
            message: `${label}：程序 ${current.name} 在 Programs 表中缺少注册行，插件不能安全更新；请先在 KLP 中修复工程。`,
          });
          break;
        }
        const issue = validateProgram(snapshot, input, op.id, usedProgramNames, usedVariableNames, stId, current.name);
        if (issue) {
          diagnostics.push({ severity: 'error', code: issue.code, message: `${label}：${issue.message}` });
          break;
        }
        if (!current.sourcePath) {
          diagnostics.push({
            severity: 'error',
            code: 'program.sourceMissing',
            message: `${label}：程序 ${current.name} 缺少源文件，不能写入或改名。`,
          });
          break;
        }
        if (input.resourceId !== current.resourceId) {
          diagnostics.push({
            severity: 'error',
            code: 'program.resourceUnsupported',
            message: `${label}：当前版本不支持把程序从资源 #${current.resourceId} 移到资源 #${input.resourceId}，因为无法确定对应的源文件目录。`,
          });
          break;
        }
        if (current.lossy) {
          diagnostics.push({
            severity: 'error',
            code: 'program.lossy',
            message: `${label}：程序 ${current.name} 的源文件含无法解码的字节，写回会损坏原文，不能改名或写入。`,
          });
          break;
        }
        if (current.name !== input.name && sameName(current.name, input.name)) {
          diagnostics.push({
            severity: 'error',
            code: 'program.caseOnlyRename',
            message: `${label}：当前版本不支持仅改变大小写的程序改名（${current.name} → ${input.name}）。请使用实际不同的名称，避免数据库、文件名和 PROGRAM 头大小写分叉。`,
          });
          break;
        }
        const renamed = !sameName(current.name, input.name);
        const oldPath = current.sourcePath;
        const newPath = path.join(path.dirname(current.sourcePath), `${input.name}.stf`);
        const row: ProgramRow = {
          name: input.name,
          comment: input.comment,
          languageId: input.languageId,
          resourceId: input.resourceId,
          order: current.order,
          readOnly: current.readOnly,
          generateSymbMon: current.generateSymbMon,
          refLocalization: current.refLocalization,
          refPouGroup: current.refPouGroup,
          generateDebugInfo: current.generateDebugInfo,
          is1499: current.is1499,
        };
        dbOps.push({ op: 'program.update', id: op.id, row });
        if (renamed) {
          // 在计划阶段就把最终文本算好：变量改名和程序改名在同一草稿中按任意顺序执行，
          // 都只更新这一份最终文本，保存层不再读旧文件二次改写。
          const renamedText = setProgramHeaderName(current.sourceText, input.name);
          current.sourceText = renamedText;
          programMoves.push({ fromPath: oldPath, toPath: newPath, newName: input.name, encoding: current.encoding });
          moveProgramWrite(oldPath, newPath);
          scheduleProgramWrite({
            path: newPath,
            fromPath: oldPath,
            text: renamedText,
            encoding: current.encoding,
            previousSha256: current.sourceSha256,
            bom: current.bom,
          });
          usedProgramNames.delete(current.name.toLowerCase());
          usedProgramNames.add(input.name.toLowerCase());
          summary.push(`重命名程序 ${current.name} → ${input.name}（源文件 PROGRAM 头同步改写）`);
          current.name = input.name;
          current.sourcePath = newPath;
        } else {
          summary.push(`修改程序 ${input.name} 属性`);
          current.name = input.name;
        }
        current.comment = input.comment;
        break;
      }
      case 'program.delete': {
        if (rejectPendingNew(label, op.id, '程序')) {
          break;
        }
        const current = programById(op.id);
        if (!current) {
          diagnostics.push({ severity: 'error', code: 'program.missing', message: `${label}：程序 #${op.id} 不存在。` });
          break;
        }
        if (current.languageId !== stId) {
          diagnostics.push({
            severity: 'error',
            code: 'program.notSt',
            message: `${label}：程序 ${current.name} 不是 ST 语言，插件禁止删除其源文件。`,
          });
          break;
        }
        if (!current.hasProgramRow) {
          diagnostics.push({
            severity: 'error',
            code: 'program.rowMissing',
            message: `${label}：程序 ${current.name} 在 Programs 表中缺少注册行，插件不能安全删除；请先在 KLP 中修复工程。`,
          });
          break;
        }
        const instances = state.variables.filter((variable) => variable.varInstanceId === 2 && variable.defTypeId === op.id);
        if (instances.length > 0) {
          diagnostics.push({
            severity: 'error',
            code: 'program.deleteBlocked',
            message: `${label}：程序 ${current.name} 仍被变量 ${instances.map((item) => item.name).join('、')} 作为功能块类型引用，不能删除。`,
          });
          break;
        }
        deletedPrograms.add(op.id);
        dbOps.push({ op: 'program.delete', id: op.id });
        if (current.sourcePath) {
          programDeletes.push({ path: current.sourcePath });
          cancelProgramWrite(current.sourcePath);
        }
        state.programs = state.programs.filter((item) => item.id !== op.id);
        if (current.tempId) {
          newProgramIds.delete(current.tempId);
        }
        usedProgramNames.delete(current.name.toLowerCase());
        summary.push(`删除程序 ${current.name}`);
        break;
      }
      case 'channel.add': {
        const input = normalizeChannelInput(op.input);
        const portIssue = validateChannelPort(input.portNum, state.channels);
        if (portIssue) {
          diagnostics.push({ severity: 'error', code: portIssue.code, message: `${label}：${portIssue.message}` });
          break;
        }
        const issue = validateChannel(input, undefined, state.channels);
        if (issue) {
          diagnostics.push({ severity: 'error', code: issue.code, message: `${label}：${issue.message}` });
          break;
        }
        const row: ChannelRow = { ...input, id: channelNextId };
        channelNextId += 1;
        newChannelIds.add(op.tempId);
        dbOps.push({ op: 'channel.insert', tempId: op.tempId, row });
        state.channels.push({ ...input, id: row.id, tempId: op.tempId });
        summary.push(`新增通讯通道 ${input.name}`);
        break;
      }
      case 'channel.update': {
        if (rejectPendingNew(label, op.id, '通道')) {
          break;
        }
        const current = channelById(op.id);
        if (!current) {
          diagnostics.push({ severity: 'error', code: 'channel.missing', message: `${label}：通道 #${op.id} 不存在。` });
          break;
        }
        const input = normalizeChannelInput(op.input);
        const portIssue = validateChannelPort(input.portNum, state.channels);
        if (portIssue) {
          diagnostics.push({ severity: 'error', code: portIssue.code, message: `${label}：${portIssue.message}` });
          break;
        }
        const issue = validateChannel(input, op.id, state.channels);
        if (issue) {
          diagnostics.push({ severity: 'error', code: issue.code, message: `${label}：${issue.message}` });
          break;
        }
        dbOps.push({ op: 'channel.update', id: op.id, row: input });
        Object.assign(current, input);
        summary.push(`修改通讯通道 ${input.name}`);
        break;
      }
      case 'channel.delete': {
        if (rejectPendingNew(label, op.id, '通道')) {
          break;
        }
        const current = channelById(op.id);
        if (!current) {
          diagnostics.push({ severity: 'error', code: 'channel.missing', message: `${label}：通道 #${op.id} 不存在。` });
          break;
        }
        const referencing = state.devices.filter((device) => refTargets(device.channelRef, current.id, current.tempId));
        if (referencing.length > 0) {
          diagnostics.push({
            severity: 'error',
            code: 'channel.deleteBlocked',
            message: `${label}：通道 ${current.name} 被设备 ${referencing.map((item) => item.name).join('、')} 引用，不能删除。`,
          });
          break;
        }
        deletedChannels.add(op.id);
        dbOps.push({ op: 'channel.delete', id: op.id });
        state.channels = state.channels.filter((item) => item.id !== op.id);
        if (current.tempId) {
          newChannelIds.delete(current.tempId);
        }
        summary.push(`删除通讯通道 ${current.name}`);
        break;
      }
      case 'device.add': {
        const input = normalizeDeviceInput(op.input);
        const issue = validateDevice(input, undefined, state.devices);
        if (issue) {
          diagnostics.push({ severity: 'error', code: issue.code, message: `${label}：${issue.message}` });
          break;
        }
        const channelId = resolveExistingRef(input.channelRef, state.channels.map((item) => item.id), newChannelIds);
        if (channelId === undefined) {
          diagnostics.push({ severity: 'error', code: 'device.channelMissing', message: `${label}：找不到所选通道。` });
          break;
        }
        const row: DeviceRow = {
          ...input,
          id: deviceNextId,
          channelRef: input.channelRef,
        };
        deviceNextId += 1;
        newDeviceIds.add(op.tempId);
        dbOps.push({ op: 'device.insert', tempId: op.tempId, row });
        state.devices.push({
          id: row.id,
          tempId: op.tempId,
          channelId: channelId.kind === 'existing' ? channelId.id : -1,
          channelRef: input.channelRef,
          name: input.name,
          protocol: input.protocol,
          interval: input.interval,
          comments: input.comments,
          modbus: input.modbus,
        });
        summary.push(`新增通讯设备 ${input.name}`);
        break;
      }
      case 'device.update': {
        if (rejectPendingNew(label, op.id, '通讯设备')) {
          break;
        }
        const current = deviceById(op.id);
        if (!current) {
          diagnostics.push({ severity: 'error', code: 'device.missing', message: `${label}：设备 #${op.id} 不存在。` });
          break;
        }
        const input = normalizeDeviceInput(op.input);
        const issue = validateDevice(input, op.id, state.devices);
        if (issue) {
          diagnostics.push({ severity: 'error', code: issue.code, message: `${label}：${issue.message}` });
          break;
        }
        const channelId = resolveExistingRef(input.channelRef, state.channels.map((item) => item.id), newChannelIds);
        if (channelId === undefined) {
          diagnostics.push({ severity: 'error', code: 'device.channelMissing', message: `${label}：找不到所选通道。` });
          break;
        }
        dbOps.push({ op: 'device.update', id: op.id, row: { ...input, id: op.id } });
        current.name = input.name;
        current.protocol = input.protocol;
        current.interval = input.interval;
        current.comments = input.comments;
        current.modbus = input.modbus;
        current.channelRef = input.channelRef;
        current.channelId = channelId.kind === 'existing' ? channelId.id : -1;
        summary.push(`修改通讯设备 ${input.name}`);
        break;
      }
      case 'device.delete': {
        if (rejectPendingNew(label, op.id, '通讯设备')) {
          break;
        }
        const current = deviceById(op.id);
        if (!current) {
          diagnostics.push({ severity: 'error', code: 'device.missing', message: `${label}：设备 #${op.id} 不存在。` });
          break;
        }
        const referencing = state.maps.filter((map) => refTargets(map.deviceRef, current.id, current.tempId));
        if (referencing.length > 0) {
          diagnostics.push({
            severity: 'error',
            code: 'device.deleteBlocked',
            message: `${label}：设备 ${current.name} 仍被 ${referencing.length} 条变量映射引用，不能删除。`,
          });
          break;
        }
        deletedDevices.add(op.id);
        dbOps.push({ op: 'device.delete', id: op.id });
        state.devices = state.devices.filter((item) => item.id !== op.id);
        if (current.tempId) {
          newDeviceIds.delete(current.tempId);
        }
        summary.push(`删除通讯设备 ${current.name}`);
        break;
      }
      case 'map.add': {
        const input = normalizeMapInput(op.input);
        const issue = validateMap(input, state, newDeviceIds, newVariableIds);
        if (issue) {
          diagnostics.push({ severity: 'error', code: issue.code, message: `${label}：${issue.message}` });
          break;
        }
        const row: MapRow = { ...input, id: mapNextId };
        mapNextId += 1;
        newMapIds.add(op.tempId);
        dbOps.push({ op: 'map.insert', tempId: op.tempId, row });
        const deviceId = resolveExistingRef(input.deviceRef, state.devices.map((item) => item.id), newDeviceIds);
        const symbolId = resolveExistingRef(input.symbolRef, state.variables.map((item) => item.id), newVariableIds);
        state.maps.push({
          id: row.id,
          tempId: op.tempId,
          deviceId: deviceId?.kind === 'existing' ? deviceId.id : -1,
          symbolId: symbolId?.kind === 'existing' ? symbolId.id : -1,
          deviceRef: input.deviceRef,
          symbolRef: input.symbolRef,
          address: input.address,
          access: input.access,
        });
        summary.push(`新增变量映射 ${input.address}`);
        break;
      }
      case 'map.update': {
        if (rejectPendingNew(label, op.id, '变量映射')) {
          break;
        }
        const current = mapById(op.id);
        if (!current) {
          diagnostics.push({ severity: 'error', code: 'map.missing', message: `${label}：映射 #${op.id} 不存在。` });
          break;
        }
        const input = normalizeMapInput(op.input);
        const issue = validateMap(input, state, newDeviceIds, newVariableIds);
        if (issue) {
          diagnostics.push({ severity: 'error', code: issue.code, message: `${label}：${issue.message}` });
          break;
        }
        dbOps.push({ op: 'map.update', id: op.id, row: { ...input, id: op.id } });
        const deviceId = resolveExistingRef(input.deviceRef, state.devices.map((item) => item.id), newDeviceIds);
        const symbolId = resolveExistingRef(input.symbolRef, state.variables.map((item) => item.id), newVariableIds);
        current.deviceRef = input.deviceRef;
        current.symbolRef = input.symbolRef;
        current.deviceId = deviceId?.kind === 'existing' ? deviceId.id : -1;
        current.symbolId = symbolId?.kind === 'existing' ? symbolId.id : -1;
        current.address = input.address;
        current.access = input.access;
        summary.push(`修改变量映射 ${input.address}`);
        break;
      }
      case 'map.delete': {
        if (rejectPendingNew(label, op.id, '变量映射')) {
          break;
        }
        const current = mapById(op.id);
        if (!current) {
          diagnostics.push({ severity: 'error', code: 'map.missing', message: `${label}：映射 #${op.id} 不存在。` });
          break;
        }
        deletedMaps.add(op.id);
        dbOps.push({ op: 'map.delete', id: op.id });
        state.maps = state.maps.filter((item) => item.id !== op.id);
        if (current.tempId) {
          newMapIds.delete(current.tempId);
        }
        summary.push(`删除变量映射 #${op.id}`);
        break;
      }
      case 'project.rename': {
        if (!projectRename) {
          diagnostics.push({
            severity: 'error',
            code: 'project.renameInvalid',
            message: `${label}：工程名无效或与当前名称相同。`,
          });
          break;
        }
        summary.push(`工程改名 ${projectRename.oldName} → ${projectRename.newName}（同时改目录与 .mgp 文件名）`);
        break;
      }
      default: {
        diagnostics.push({ severity: 'error', code: 'draft.unknownOp', message: `${label}：无法识别的修改类型。` });
      }
    }
  }

  // 引用一致性：草稿中被删除对象仍被保留下来的对象引用时阻止保存。
  if (projectRename) {
    const renameIssue = validateProjectRename(snapshot, projectRename.newName);
    if (renameIssue) {
      diagnostics.push({ severity: 'error', code: renameIssue.code, message: renameIssue.message });
    }
  }

  const finalVariableIds = new Set(state.variables.map((item) => item.id));
  const finalDeviceIds = new Set(state.devices.map((item) => item.id));
  const finalChannelIds = new Set(state.channels.map((item) => item.id));
  for (const device of state.devices) {
    if (refExists(device.channelRef, finalChannelIds, newChannelIds)) {
      continue;
    }
    if (!initialDanglingDevices.has(device.id)) {
      diagnostics.push({
        severity: 'error',
        code: 'device.channelOrphan',
        message: `设备 ${device.name} 保存后将引用不存在的通道，已阻止保存。`,
      });
    }
  }
  for (const map of state.maps) {
    const symbolOk = refExists(map.symbolRef, finalVariableIds, newVariableIds);
    const deviceOk = refExists(map.deviceRef, finalDeviceIds, newDeviceIds);
    if (symbolOk && deviceOk) {
      continue;
    }
    const preexisting = initialDangling.has(map.id);
    if (!preexisting) {
      diagnostics.push({
        severity: 'error',
        code: 'map.newOrphan',
        message: `映射 #${map.id}（地址 ${map.address}）在保存后会引用不存在的${symbolOk ? '设备' : '变量'}，已阻止保存。请先删除该映射或恢复引用对象。`,
      });
    }
  }

  validateProgramFileTargets(snapshot, programWrites, programMoves, programDeletes, diagnostics);

  const finalProgramWrites = programWrites.filter(
    (write): write is DraftPlan['programWrites'][number] => Boolean(write),
  );
  const canSave =
    diagnostics.every((diagnostic) => diagnostic.severity !== 'error') &&
    (dbOps.length > 0 ||
      finalProgramWrites.length > 0 ||
      programMoves.length > 0 ||
      programDeletes.length > 0 ||
      Boolean(projectRename));
  if (!canSave && diagnostics.length === 0) {
    summary.push('没有待保存的修改。');
  }

  const effective: EffectiveState = {
    variables: state.variables,
    programs: state.programs.map((program) => ({
      id: program.id,
      name: program.name,
      comment: program.comment,
      languageId: program.languageId,
      resourceId: program.resourceId,
      order: program.order,
      fatherId: program.fatherId,
      readOnly: program.readOnly,
      generateSymbMon: program.generateSymbMon,
      encrypted: program.encrypted,
      refLocalization: program.refLocalization,
      refPouGroup: program.refPouGroup,
      generateDebugInfo: program.generateDebugInfo,
      is1499: program.is1499,
      hasProgramRow: program.hasProgramRow,
    })),
    channels: state.channels,
    devices: state.devices,
    maps: state.maps,
  };

  return {
    diagnostics,
    canSave,
    summary: dedupe(summary),
    programWrites: finalProgramWrites,
    programMoves,
    programDeletes,
    projectRename: projectRename
      ? {
          fromDir: projectRename.fromDir,
          toDir: projectRename.toDir,
          fromEntry: projectRename.fromEntry,
          toEntry: projectRename.toEntry,
          newName: projectRename.newName,
        }
      : undefined,
    dbOps,
    effective,
  };
}

interface PlannedRename {
  oldName: string;
  newName: string;
  fromDir: string;
  toDir: string;
  fromEntry: string;
  toEntry: string;
}

function planProjectRename(snapshot: ProjectSnapshot, draft: Draft, diagnostics: Diagnostic[]): PlannedRename | undefined {
  const op = draft.ops.find((item): item is Extract<DraftOp, { kind: 'project.rename' }> => item.kind === 'project.rename');
  if (!op) {
    return undefined;
  }
  const issue = validateProjectName(op.newName);
  if (issue) {
    diagnostics.push({ severity: 'error', code: issue.code, message: issue.message });
    return undefined;
  }
  const oldName = snapshot.project.name;
  if (sameName(oldName, op.newName)) {
    return undefined;
  }
  const fromDir = snapshot.projectDir;
  const parent = path.dirname(fromDir);
  const newName = op.newName.trim();
  return {
    oldName,
    newName,
    fromDir,
    toDir: path.join(parent, newName),
    fromEntry: snapshot.entryPath,
    toEntry: path.join(fromDir, `${newName}.mgp`),
  };
}

function validateProjectRename(snapshot: ProjectSnapshot, newName: string): { code: string; message: string } | undefined {
  if (sameName(snapshot.project.name, newName)) {
    return { code: 'project.renameSame', message: '新工程名与当前名称相同。' };
  }
  // 校验目标，而不是当前目录名：工程可能位于一个临时/备份目录名中，
  // 只要目标名称合法且不冲突，就应允许整体改名。
  const toDir = path.join(path.dirname(snapshot.projectDir), newName);
  if (toDir.toLowerCase() !== snapshot.projectDir.toLowerCase() && existsSync(toDir)) {
    return { code: 'project.targetExists', message: `目标目录已存在：${toDir}` };
  }
  const toEntry = path.join(snapshot.projectDir, `${newName}.mgp`);
  if (toEntry.toLowerCase() !== snapshot.entryPath.toLowerCase() && existsSync(toEntry)) {
    return { code: 'project.entryExists', message: `目标入口文件已存在：${toEntry}` };
  }
  return undefined;
}

function normalizeVariableInput(input: import('../shared/types').VariableInput) {
  return {
    ...input,
    name: normalizeName(input.name),
    comment: input.comment.trim(),
    userAddress: input.userAddress.trim(),
    wiring: input.wiring.trim(),
    initialValue: input.initialValue,
  };
}

function normalizeProgramInput(input: import('../shared/types').ProgramInput) {
  return { ...input, name: normalizeName(input.name), comment: input.comment.trim() };
}

function normalizeChannelInput(input: import('../shared/types').ChannelInput) {
  return {
    ...input,
    name: input.name.trim(),
    protocol: input.protocol.trim(),
    destIp: input.destIp.trim(),
    baudrate: input.baudrate.trim(),
    databits: input.databits.trim(),
    parity: input.parity.trim(),
    stopbits: input.stopbits.trim(),
    comments: input.comments.trim(),
  };
}

function normalizeDeviceInput(input: import('../shared/types').CommDeviceInput) {
  return { ...input, name: input.name.trim(), protocol: input.protocol.trim(), comments: input.comments.trim() };
}

function normalizeMapInput(input: import('../shared/types').VariableMapInput) {
  return { ...input, address: input.address.trim() };
}

function pickVariableTemplate(variables: VariableRecord[], input: { defTypeId: number; varInstanceId: number }): VariableRecord | undefined {
  return (
    variables.find((variable) => variable.defTypeId === input.defTypeId && variable.varInstanceId === input.varInstanceId) ??
    variables.find((variable) => variable.defTypeId === input.defTypeId) ??
    variables[0]
  );
}

function toVariableRecord(idOrTemp: number | string, row: VariableRow): VariableRecord {
  return {
    id: typeof idOrTemp === 'number' ? idOrTemp : -1,
    name: row.name,
    comment: row.comment,
    alias: row.alias,
    varInstanceId: row.varInstanceId,
    resourcePouId: row.resourcePouId,
    scopeId: row.scopeId,
    defTypeId: row.defTypeId,
    stringSize: row.stringSize,
    attributeId: row.attributeId,
    directionId: row.directionId,
    groupId: row.groupId,
    userAddress: row.userAddress,
    wiring: row.wiring,
    isRetain: row.isRetain,
    order: row.order,
    hasDimension: row.hasDimension,
    initialValue: row.initialValue,
    refLibrary: row.refLibrary,
    hook: row.hook,
    crcInitValueDim: row.crcInitValueDim,
    crcInitValueType: row.crcInitValueType,
    status: row.status,
  };
}

function validateVariable(
  snapshot: ProjectSnapshot,
  input: import('../shared/types').VariableInput,
  selfId: number | undefined,
  usedNames: Set<string>,
  usedProgramNames: Set<string>,
  currentName?: string,
): { code: string; message: string } | undefined {
  const db = snapshot.db;
  if (!db) {
    return { code: 'db.missing', message: '数据库未读取。' };
  }
  const nameIssue = validateIdentifier(input.name, '变量名');
  if (nameIssue) {
    return nameIssue;
  }
  const lower = input.name.toLowerCase();
  if (usedNames.has(lower) && lower !== currentName?.toLowerCase()) {
    const other = db.variables.find((variable) => variable.name.toLowerCase() === lower);
    if (!other || other.id !== selfId) {
      return { code: 'variable.duplicate', message: `已存在同名变量 ${input.name}。` };
    }
  }
  if (lower !== currentName?.toLowerCase() && usedProgramNames.has(lower)) {
    return { code: 'variable.pouName', message: `名称 ${input.name} 已被程序或功能块使用，变量与 POU 不能同名。` };
  }
  if (input.name.length > 128) {
    return { code: 'variable.tooLong', message: '变量名不能超过 128 个字符。' };
  }
  if (!db.groups.some((group) => group.id === input.groupId)) {
    return { code: 'variable.group', message: '所选变量组不存在。' };
  }
  if (!db.directions.some((item) => item.id === input.directionId)) {
    return { code: 'variable.direction', message: '所选方向不存在。' };
  }
  if (!db.attributes.some((item) => item.id === input.attributeId)) {
    return { code: 'variable.attribute', message: '所选属性不存在。' };
  }
  if (!db.scopes.some((item) => item.id === input.scopeId)) {
    return { code: 'variable.scope', message: '所选作用域不存在。' };
  }
  if (!db.varInstances.some((item) => item.id === input.varInstanceId)) {
    return { code: 'variable.instance', message: '所选变量类别不存在。' };
  }
  if (input.varInstanceId === 2) {
    const pou = db.pous.find((item) => item.id === input.defTypeId && item.typeId === 3);
    if (!pou) {
      return { code: 'variable.fbType', message: '功能块实例必须选择一个功能块类型。' };
    }
  } else if (!db.definitionTypes.some((item) => item.id === input.defTypeId)) {
    return { code: 'variable.defType', message: '所选数据类型不存在。' };
  }
  if (input.wiring && !/^%[IQ][A-Za-z]?\d+(\.\d+)?$/.test(input.wiring)) {
    return { code: 'variable.wiring', message: `I/O 组态“${input.wiring}”格式不正确，应形如 %IR0.0 或 %QR1.0。` };
  }
  return undefined;
}

function validateProgram(
  snapshot: ProjectSnapshot,
  input: import('../shared/types').ProgramInput,
  selfId: number | undefined,
  usedNames: Set<string>,
  usedVariableNames: Set<string>,
  stId: number | undefined,
  currentName?: string,
): { code: string; message: string } | undefined {
  const nameIssue = validateIdentifier(input.name, '程序名');
  if (nameIssue) {
    return nameIssue;
  }
  if (stId === undefined) {
    return { code: 'program.noStLanguage', message: '数据库中没有 ST 语言记录，插件无法判断程序语言，禁止写入。' };
  }
  if (input.languageId !== stId) {
    return { code: 'program.language', message: '插件只支持 ST 程序，不能写入其他语言。' };
  }
  const db = snapshot.db;
  if (!db) {
    return { code: 'db.missing', message: '数据库未读取。' };
  }
  if (!db.resources.some((resource) => resource.id === input.resourceId)) {
    return { code: 'program.resource', message: '所选资源不存在。' };
  }
  const lower = input.name.toLowerCase();
  if (lower !== currentName?.toLowerCase() && usedVariableNames.has(lower)) {
    return { code: 'program.variableName', message: `名称 ${input.name} 已被变量使用，程序与变量不能同名。` };
  }
  if (usedNames.has(lower) && lower !== currentName?.toLowerCase()) {
    return { code: 'program.duplicate', message: `名称 ${input.name} 已被其他 POU 使用。` };
  }
  return undefined;
}

function validateChannelPort(
  portNum: number,
  channels: ChannelRecord[],
): { code: string; message: string } | undefined {
  if (!Number.isInteger(portNum) || portNum < 0) {
    return undefined; // 由 validateChannel 给出字段错误
  }
  const configured = new Set(channels.map((channel) => channel.portNum));
  if (!configured.has(portNum)) {
    return {
      code: 'channel.portUnverified',
      message: `端口 ${portNum} 当前没有已存在的网关通道。插件不修改 PortNetwork.mcf 等端口配置，KLP 可能不显示新建通道；请先在 KLP 中配置该端口，或选择已有通道使用的端口。`,
    };
  }
  return undefined;
}

function validateChannel(
  input: import('../shared/types').ChannelInput,
  selfId: number | undefined,
  channels: ChannelRecord[],
): { code: string; message: string } | undefined {
  const issue = validateFreeTextName(input.name, '通道名', 64);
  if (issue) {
    return issue;
  }
  const conflict = channels.find((channel) => channel.name.toLowerCase() === input.name.toLowerCase() && channel.id !== selfId);
  if (conflict) {
    return { code: 'channel.duplicate', message: `已存在同名通道 ${input.name}。` };
  }
  for (const [field, value] of [
    ['扫描周期', input.interval],
    ['超时', input.timeout],
    ['重试次数', input.retry],
    ['重连间隔', input.watchtime],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      return { code: 'channel.number', message: `${field}必须是非负整数。` };
    }
  }
  if (!Number.isInteger(input.portNum) || input.portNum < 0) {
    return { code: 'channel.port', message: '端口号必须是非负整数。' };
  }
  return undefined;
}

function validateDevice(
  input: import('../shared/types').CommDeviceInput,
  selfId: number | undefined,
  devices: CommDeviceRecord[],
): { code: string; message: string } | undefined {
  const issue = validateFreeTextName(input.name, '设备名', 64);
  if (issue) {
    return issue;
  }
  const conflict = devices.find((device) => device.name.toLowerCase() === input.name.toLowerCase() && device.id !== selfId);
  if (conflict) {
    return { code: 'device.duplicate', message: `已存在同名通讯设备 ${input.name}。` };
  }
  if (!Number.isInteger(input.interval) || input.interval < 0) {
    return { code: 'device.interval', message: '扫描周期必须是非负整数。' };
  }
  if (!Number.isInteger(input.modbus.station) || input.modbus.station < 0 || input.modbus.station > 255) {
    return { code: 'device.station', message: 'Modbus 站号必须在 0 到 255 之间。' };
  }
  return undefined;
}

function validateMap(
  input: import('../shared/types').VariableMapInput,
  state: WorkingState,
  newDevices: Set<string>,
  newVariables: Set<string>,
): { code: string; message: string } | undefined {
  if (!input.address) {
    return { code: 'map.address', message: '映射地址不能为空。' };
  }
  if (!Number.isInteger(input.access) || input.access < 0 || input.access > 2) {
    return { code: 'map.access', message: '访问权限必须是 0、1 或 2。' };
  }
  if (resolveExistingRef(input.deviceRef, state.devices.map((item) => item.id), newDevices) === undefined) {
    return { code: 'map.device', message: '映射引用的设备不存在（可能已被删除）。' };
  }
  if (resolveExistingRef(input.symbolRef, state.variables.map((item) => item.id), newVariables) === undefined) {
    return { code: 'map.symbol', message: '映射引用的变量不存在（可能已被删除）。' };
  }
  return undefined;
}

type ResolvedRef = { kind: 'existing'; id: number } | { kind: 'new'; tempId: string };

function resolveExistingRef(ref: EntityRef, existingIds: number[], newIds: Set<string>): ResolvedRef | undefined {
  if (ref.kind === 'existing') {
    return existingIds.includes(ref.id) ? { kind: 'existing', id: ref.id } : undefined;
  }
  return newIds.has(ref.tempId) ? { kind: 'new', tempId: ref.tempId } : undefined;
}

function refExists(ref: EntityRef, existingIds: Set<number>, newIds: Set<string>): boolean {
  return ref.kind === 'existing' ? existingIds.has(ref.id) : newIds.has(ref.tempId);
}

function refTargets(ref: EntityRef, id: number, tempId?: string): boolean {
  return ref.kind === 'existing' ? ref.id === id : Boolean(tempId && ref.tempId === tempId);
}

function validateProgramFileTargets(
  snapshot: ProjectSnapshot,
  writes: Array<DraftPlan['programWrites'][number] | undefined>,
  moves: DraftPlan['programMoves'],
  deletes: DraftPlan['programDeletes'],
  diagnostics: Diagnostic[],
): void {
  const removed = new Set(
    [...moves.map((move) => move.fromPath), ...deletes.map((item) => item.path)]
      .filter(Boolean)
      .map((item) => item.toLowerCase()),
  );
  const seen = new Map<string, string>();
  for (const write of writes) {
    if (!write?.path) {
      continue;
    }
    const key = write.path.toLowerCase();
    if (seen.has(key)) {
      diagnostics.push({
        severity: 'error',
        code: 'program.fileConflict',
        message: `本次保存有多个程序写入同一个文件：${write.path}`,
      });
      continue;
    }
    seen.set(key, write.path);
    if (!write.fromPath) {
      // 没有来源路径 = 新增程序目标，目标文件必须不存在（或由本草稿删除/移走）。
      if (existsSync(write.path) && !removed.has(key)) {
        diagnostics.push({
          severity: 'error',
          code: 'program.fileExists',
          message: `目标源文件已存在且不属于本次草稿要移走的程序：${write.path}。为避免覆盖未注册文件，已阻止保存。`,
        });
      }
      continue;
    }
    if (write.fromPath.toLowerCase() === key) {
      continue;
    }
    if (!existsSync(write.path)) {
      continue;
    }
    if (removed.has(key)) {
      continue;
    }
    diagnostics.push({
      severity: 'error',
      code: 'program.fileExists',
      message: `目标源文件已存在且不属于本次草稿要移走的程序：${write.path}。为避免覆盖未注册文件，已阻止保存。`,
    });
  }
  void snapshot;
}

function describeVariableDeletionBlock(
  snapshot: ProjectSnapshot,
  state: WorkingState,
  variable: VariableState,
  deletedMaps: Set<number>,
): string | undefined {
  const io = snapshot.db?.ioBindings.find((binding) => binding.symbolId === variable.id && variable.id > 0);
  if (io) {
    return `变量 ${variable.name} 绑定了物理 I/O（实例 ${io.refInstance}，物理序号 ${io.physicalOrder}），必须先解除硬件组态。`;
  }
  const maps = state.maps.filter(
    (map) => !deletedMaps.has(map.id) && refTargets(map.symbolRef, variable.id, variable.tempId),
  );
  if (maps.length > 0) {
    return `变量 ${variable.name} 仍被 ${maps.length} 条通讯映射引用，请先删除这些映射。`;
  }
  const references = collectVariableReferences(snapshot, state, variable.name);
  if (references.usages.length > 0) {
    const programs = [...new Set(references.usages.map((usage) => usage.program))].join('、');
    return `变量 ${variable.name} 仍在程序 ${programs} 中使用（共 ${references.usages.length} 处），请先删除相关代码或改用重命名。`;
  }
  return undefined;
}

function collectVariableReferences(
  snapshot: ProjectSnapshot,
  state: WorkingState,
  name: string,
): { usages: Array<{ program: string; line: number; column: number; excerpt: string }>; programNames: string[] } {
  void snapshot;
  const usages: Array<{ program: string; line: number; column: number; excerpt: string }> = [];
  for (const program of state.programs) {
    if (!program.sourceText) {
      continue;
    }
    usages.push(...findIdentifierUsages(program.sourceText, name, program.name));
  }
  return { usages, programNames: [...new Set(usages.map((usage) => usage.program))] };
}

function replaceInProgramText(text: string, from: string, to: string): { text: string; count: number } {
  return replaceIdentifier(text, from, to);
}

function ensureProgramText(name: string, text: string): string {
  const normalized = text.replace(/\r\n|\r|\n/g, '\r\n');
  let body = setProgramHeaderName(normalized, name);
  if (!/\bEND_PROGRAM\b/i.test(body)) {
    body = body.replace(/\s*$/, '\r\n');
    body += 'END_PROGRAM\r\n';
  }
  return body;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
