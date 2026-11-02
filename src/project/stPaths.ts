import * as path from 'node:path';
import type { ProjectSnapshot } from '../shared/types.ts';

function resolveKey(target: string): string {
  return path.resolve(target).replace(/\//g, '\\').toLowerCase();
}

function stLanguageId(snapshot: ProjectSnapshot): number | undefined {
  return snapshot.db?.languages.find((language) => language.name.toUpperCase() === 'ST')?.id;
}

function primaryLayout(snapshot: ProjectSnapshot) {
  const dbDir = snapshot.dbPath ? path.resolve(path.dirname(snapshot.dbPath)).toLowerCase() : undefined;
  return (
    snapshot.devices.find(
      (device) => device.dataDirPath && dbDir && path.resolve(device.dataDirPath).toLowerCase() === dbDir,
    ) ??
    snapshot.devices.find(
      (device) => device.dbPath && snapshot.dbPath && path.resolve(device.dbPath).toLowerCase() === path.resolve(snapshot.dbPath).toLowerCase(),
    ) ??
    snapshot.devices.find((device) => device.resourcePath)
  );
}

/** 主数据库程序到源文件的映射，语言 ID 来自主数据库。 */
function primaryEntries(snapshot: ProjectSnapshot): Array<{ path: string; languageId: number }> {
  if (!snapshot.db) {
    return [];
  }
  const layout = primaryLayout(snapshot);
  if (!layout?.resourcePath) {
    return [];
  }
  const entries: Array<{ path: string; languageId: number }> = [];
  const resourceRoot = path.resolve(layout.resourcePath);
  snapshot.db.programs.forEach((program, index) => {
    const source = layout.programs[index];
    if (source?.path) {
      entries.push({ path: source.path, languageId: program.languageId });
      return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(program.name)) {
      return;
    }
    const target = path.resolve(resourceRoot, `${program.name}.stf`);
    const relative = path.relative(resourceRoot, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return;
    }
    entries.push({ path: target, languageId: program.languageId });
  });
  return entries;
}

/**
 * `klp-st:` 只允许访问当前工程中已注册的程序源文件。
 * 这不是性能优化，而是安全边界：`klp-st:` URI 可以由任意字符串构造，
 * 若不校验，命令/扩展外部可以借此读写工程外任意路径。
 */
export function allowedStSourcePaths(snapshot: ProjectSnapshot | undefined): Set<string> {
  if (!snapshot) {
    return new Set();
  }
  const allowed = new Set<string>();
  for (const device of snapshot.devices) {
    for (const program of device.programs) {
      if (program.path) {
        allowed.add(resolveKey(program.path));
      }
    }
  }
  for (const entry of primaryEntries(snapshot)) {
    allowed.add(resolveKey(entry.path));
  }
  return allowed;
}

export function isAllowedStSourcePath(snapshot: ProjectSnapshot | undefined, target: string): boolean {
  if (!target.toLowerCase().endsWith('.stf')) {
    return false;
  }
  return allowedStSourcePaths(snapshot).has(resolveKey(target));
}

/** 只有主数据库中的 ST 已注册源文件允许通过 `klp-st:` 写回。 */
export function isWritableStSourcePath(snapshot: ProjectSnapshot | undefined, target: string): boolean {
  if (!target.toLowerCase().endsWith('.stf')) {
    return false;
  }
  const key = resolveKey(target);
  const stId = snapshot ? stLanguageId(snapshot) : undefined;
  if (!snapshot || stId === undefined) {
    return false;
  }
  return primaryEntries(snapshot).some((entry) => entry.languageId === stId && resolveKey(entry.path) === key);
}
