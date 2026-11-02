import * as path from 'node:path';
import { stat } from 'node:fs/promises';
import type {
  DbSnapshot,
  DeviceLayout,
  Diagnostic,
  FileStamp,
  KlpDevice,
  KlpProject,
  ProgramSource,
  ProjectSnapshot,
} from '../shared/types.ts';
import { JetBridge } from '../mdb/jet.ts';
import { decodeStBytes, hasUtf8Bom } from '../util/encoding.ts';
import { findEntry, isDirectory, listDirectory, readBytes, stampFile } from '../util/fsx.ts';
import { parseMgp } from './mgpParser.ts';
import { isUnsafeDataDirName, pathOutsideReason, physicalPath } from './pathSafety.ts';
import { programHeaderName } from './st.ts';
import { ProjectOpenError, discoverEntries } from './discovery.ts';

export { ProjectOpenError, discoverEntries };
export type { EntryCandidate } from './discovery.ts';

interface ResolvedDirs {
  dataDirPath?: string;
  configName?: string;
  resourceName?: string;
  resourcePath?: string;
  mdbPath?: string;
}

async function firstDirectory(dir: string, preferred: string[]): Promise<string | undefined> {
  for (const name of preferred) {
    const hit = await findEntry(dir, name);
    if (hit && (await isDirectory(hit))) {
      return path.basename(hit);
    }
  }
  for (const entry of await listDirectory(dir)) {
    const full = path.join(dir, entry);
    if (await isDirectory(full)) {
      return entry;
    }
  }
  return undefined;
}

async function resolveDeviceDirs(projectDir: string, device: KlpDevice, db?: DbSnapshot): Promise<ResolvedDirs> {
  if (!device.dataDir) {
    return {};
  }
  const dataDirPath = await findEntry(projectDir, device.dataDir);
  if (!dataDirPath || !(await isDirectory(dataDirPath))) {
    return {};
  }
  const mdbPath = await findEntry(dataDirPath, 'PrjLibrary.mdb');
  const configName = db?.configurationName ?? (await firstDirectory(dataDirPath, ['Config1']));
  let resourceName = db?.resourceName;
  let resourcePath: string | undefined;
  if (configName) {
    const configPath = (await findEntry(dataDirPath, configName)) ?? (await findEntry(dataDirPath, 'Config1'));
    if (configPath) {
      resourceName = resourceName ?? (await firstDirectory(configPath, ['Resource1']));
      if (resourceName) {
        resourcePath = (await findEntry(configPath, resourceName)) ?? (await findEntry(configPath, 'Resource1'));
      }
    }
  }
  return { dataDirPath, configName, resourceName, resourcePath, mdbPath };
}

async function collectProgramSources(
  programs: DbSnapshot['programs'],
  resourcePath: string | undefined,
  diagnostics: Diagnostic[],
): Promise<ProgramSource[]> {
  const sources: ProgramSource[] = [];
  const registered = new Set<string>();
  const files = resourcePath ? await listDirectory(resourcePath) : [];
  const stfFiles = files.filter((name) => name.toLowerCase().endsWith('.stf'));
  for (const program of programs) {
    registered.add(`${program.name.toLowerCase()}.stf`);
    if (!resourcePath) {
      diagnostics.push({
        severity: 'warning',
        code: 'program.dirMissing',
        message: `无法定位程序目录，程序 ${program.name} 的 ST 源文件不可读。`,
        target: program.name,
      });
      sources.push({ encoding: 'gbk', missing: true });
      continue;
    }
    const candidate = stfFiles.find((name) => name.toLowerCase() === `${program.name.toLowerCase()}.stf`);
    if (!candidate) {
      diagnostics.push({
        severity: 'warning',
        code: 'program.sourceMissing',
        message: `程序 ${program.name} 已注册，但缺少 ${program.name}.stf 源文件。`,
        target: program.name,
      });
      sources.push({ encoding: 'gbk', missing: true });
      continue;
    }
    const full = path.join(resourcePath, candidate);
    const bytes = await readBytes(full);
    const decoded = decodeStBytes(bytes);
    const stamp = await stampFile(full);
    if (decoded.lossy) {
      diagnostics.push({
        severity: 'warning',
        code: 'program.decodeLossy',
        message: `程序 ${program.name} 的源文件存在无法解码的字节，写回可能破坏原文。`,
        target: full,
      });
    }
    const header = programHeaderName(decoded.text);
    if (header && header.toLowerCase() !== program.name.toLowerCase()) {
      diagnostics.push({
        severity: 'warning',
        code: 'program.headerMismatch',
        message: `程序 ${program.name} 的源文件头写的是 PROGRAM ${header}，与数据库注册名不一致。`,
        target: full,
      });
    }
    sources.push({
      path: full,
      text: decoded.text,
      sha256: stamp.sha256,
      encoding: decoded.encoding,
      bom: hasUtf8Bom(bytes),
      lossy: decoded.lossy,
      missing: false,
    });
  }
  for (const name of stfFiles) {
    if (!registered.has(name.toLowerCase())) {
      diagnostics.push({
        severity: 'info',
        code: 'program.unregistered',
        message: `源文件 ${name} 没有对应的数据库程序注册，插件不会自动删除它。`,
        target: name,
      });
    }
  }
  return sources;
}

function describeMissingReferences(db: DbSnapshot, diagnostics: Diagnostic[]): void {
  const deviceIds = new Set(db.devices.map((device) => device.id));
  const symbolIds = new Set(db.variables.map((variable) => variable.id));
  let orphanMaps = 0;
  for (const map of db.maps) {
    if (!deviceIds.has(map.deviceId) || !symbolIds.has(map.symbolId)) {
      orphanMaps += 1;
    }
  }
  if (orphanMaps > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'map.orphan',
      message: `通讯映射中有 ${orphanMaps} 条记录引用了不存在的设备或变量（KLP 加载时会跳过）。插件只报告，不自动清理。`,
    });
  }
  const channelIds = new Set(db.channels.map((channel) => channel.id));
  const deviceOrphans = db.devices.filter((device) => !channelIds.has(device.channelId));
  if (deviceOrphans.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'device.channelOrphan',
      message: `通讯设备中有 ${deviceOrphans.length} 条记录引用了不存在的通道（已存在记录会保留，插件不会新建此类引用）。`,
    });
  }
  const ioOrphans = db.ioBindings.filter((binding) => !symbolIds.has(binding.symbolId));
  if (ioOrphans.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'io.orphan',
      message: `物理 I/O 绑定中有 ${ioOrphans.length} 条记录引用了不存在的变量。`,
    });
  }
  for (const program of db.programs) {
    const language = db.languages.find((item) => item.id === program.languageId)?.name;
    if (language && language.toUpperCase() !== 'ST') {
      diagnostics.push({
        severity: 'warning',
        code: 'program.nonSt',
        message: `程序 ${program.name} 的语言是 ${language}，插件只支持 ST，禁止写入该程序。`,
        target: program.name,
      });
    }
  }
}

export interface OpenedDevice {
  layout: DeviceLayout;
  db?: DbSnapshot;
  dbPath?: string;
}

/**
 * 打开工程：解析 .mgp、定位设备目录、读取数据库与 ST 源文件、生成诊断。
 * .mgp 无法解析时抛错；其余缺失记为诊断，避免整窗失败。
 */
export async function openProject(entryPath: string, bridge: JetBridge): Promise<ProjectSnapshot> {
  const diagnostics: Diagnostic[] = [];
  const stamps: FileStamp[] = [];
  const entryStamp = await stampFile(entryPath).catch(() => undefined);
  if (!entryStamp) {
    throw new ProjectOpenError(`入口文件不可读：${entryPath}`);
  }
  stamps.push(entryStamp);

  const xml = new TextDecoder('utf-8').decode(await readBytes(entryPath)).replace(/^\uFEFF/, '');
  let project: KlpProject;
  try {
    project = parseMgp(xml);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProjectOpenError(`解析 ${path.basename(entryPath)} 失败：${message}`);
  }

  const projectDir = path.dirname(entryPath);
  const unsafePaths: string[] = [];
  let physicalRoot: string;
  try {
    physicalRoot = await physicalPath(projectDir);
  } catch (error) {
    physicalRoot = path.resolve(projectDir);
    unsafePaths.push(projectDir);
    diagnostics.push({
      severity: 'error',
      code: 'path.unverifiable',
      message: `工程根目录的物理位置无法验证，已禁止写入：${error instanceof Error ? error.message : String(error)}`,
      target: projectDir,
    });
  }
  const devices: DeviceLayout[] = [];
  const deviceDbs: OpenedDevice[] = [];
  const checkPhysical = async (target: string | undefined, label: string): Promise<void> => {
    if (!target) {
      return;
    }
    const reason = await pathOutsideReason(physicalRoot, target, label);
    if (reason) {
      unsafePaths.push(target);
      diagnostics.push({ severity: 'error', code: 'path.outsideProject', message: reason, target });
    }
  };
  await checkPhysical(entryPath, '工程入口');

  for (const device of project.devices) {
    if (device.dataDir && isUnsafeDataDirName(device.dataDir)) {
      unsafePaths.push(path.join(projectDir, device.dataDir));
      diagnostics.push({
        severity: 'error',
        code: 'device.dataDirInvalid',
        message: `设备 ${device.name} 的 DataDir “${device.dataDir}” 不是工程根目录下的单层目录名；拒绝写入。`,
        target: device.name,
      });
      devices.push({ deviceName: device.name, dataDir: device.dataDir, programs: [] });
      continue;
    }
    if (!device.dataDir) {
      diagnostics.push({
        severity: 'error',
        code: 'device.noDataDir',
        message: `设备 ${device.name} 没有 DataDir，无法定位工程数据目录。`,
        target: device.name,
      });
      devices.push({ deviceName: device.name, programs: [] });
      continue;
    }
    const dirs = await resolveDeviceDirs(projectDir, device);
    await checkPhysical(dirs.dataDirPath, `设备 ${device.name} 的 DataDir`);
    await checkPhysical(dirs.mdbPath, `设备 ${device.name} 的 PrjLibrary.mdb`);
    await checkPhysical(dirs.resourcePath, `设备 ${device.name} 的资源目录`);
    if (!dirs.dataDirPath) {
      diagnostics.push({
        severity: 'error',
        code: 'device.dirMissing',
        message: `设备 ${device.name} 的 DataDir “${device.dataDir}” 不存在。`,
        target: device.name,
      });
      devices.push({ deviceName: device.name, dataDir: device.dataDir, programs: [] });
      continue;
    }

    let db: DbSnapshot | undefined;
    if (!dirs.mdbPath) {
      diagnostics.push({
        severity: 'error',
        code: 'db.missing',
        message: `设备 ${device.name} 的目录中找不到 PrjLibrary.mdb。`,
        target: dirs.dataDirPath,
      });
    } else {
      stamps.push(await stampFile(dirs.mdbPath));
      try {
        db = await bridge.snapshot(dirs.mdbPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        diagnostics.push({
          severity: 'error',
          code: 'db.unreadable',
          message: `读取数据库失败：${message}`,
          target: dirs.mdbPath,
        });
      }
    }

    if (db) {
      describeMissingReferences(db, diagnostics);
    }

    const sources = db ? await collectProgramSources(db.programs, dirs.resourcePath, diagnostics) : [];
    for (const source of sources) {
      if (source.path) {
        await checkPhysical(source.path, `程序源文件 ${path.basename(source.path)}`);
      }
      if (source.path) {
        const existing = stamps.find((stamp) => stamp.path === source.path);
        if (!existing) {
          stamps.push(await stampFile(source.path));
        }
      }
    }

    devices.push({
      deviceName: device.name,
      dataDir: device.dataDir,
      dataDirPath: dirs.dataDirPath,
      configName: dirs.configName,
      resourceName: dirs.resourceName,
      resourcePath: dirs.resourcePath,
      resourceId: db?.resources[0]?.id,
      dbPath: dirs.mdbPath,
      programs: sources,
    });
    deviceDbs.push({
      layout: devices[devices.length - 1] as DeviceLayout,
      db,
      dbPath: dirs.mdbPath,
    });
  }

  if (deviceDbs.filter((entry) => entry.db).length > 1) {
    diagnostics.push({
      severity: 'warning',
      code: 'db.multiDevice',
      message: '工程包含多个可读的设备数据库；当前版本只对第一个设备开放编辑。',
    });
  }

  const primary = deviceDbs.find((entry) => entry.db && entry.dbPath);

  return {
    entryPath,
    projectDir,
    physicalRoot,
    pathSafety:
      unsafePaths.length > 0
        ? {
            writable: false,
            unsafePaths,
            message: `工程中有 ${unsafePaths.length} 个数据路径的物理位置越出工程根目录（可能是 junction/symlink），已禁止保存。`,
          }
        : { writable: true, unsafePaths: [] },
    project,
    dbPath: primary?.dbPath,
    db: primary?.db,
    devices,
    stamps,
    diagnostics,
    loadedAt: Date.now(),
  };
}

/**
 * 返回与 `snapshot.db` 配对的设备布局。
 * 不能简单取 devices[0]：多设备工程里第一个设备可能没有可读数据库，
 * 而数据库来自后面的设备，资源目录必须跟着数据库走。
 */
export function dbDeviceLayout(snapshot: ProjectSnapshot): DeviceLayout | undefined {
  if (!snapshot.dbPath) {
    return snapshot.devices.find((device) => device.resourcePath) ?? snapshot.devices[0];
  }
  const dbDir = path.resolve(path.dirname(snapshot.dbPath)).toLowerCase();
  const byDir = snapshot.devices.find(
    (device) => device.dataDirPath && path.resolve(device.dataDirPath).toLowerCase() === dbDir,
  );
  if (byDir) {
    return byDir;
  }
  return (
    snapshot.devices.find((device) => device.dbPath && path.resolve(device.dbPath).toLowerCase() === path.resolve(snapshot.dbPath ?? '').toLowerCase()) ??
    snapshot.devices.find((device) => device.resourcePath) ??
    snapshot.devices[0]
  );
}

export async function reloadDb(snapshot: ProjectSnapshot, bridge: JetBridge): Promise<DbSnapshot | undefined> {
  if (!snapshot.dbPath) {
    return undefined;
  }
  return bridge.snapshot(snapshot.dbPath);
}
