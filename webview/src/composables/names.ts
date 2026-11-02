/** 路径、名称索引与程序源码查找。全部为纯函数，不持有状态。 */
import type { DeviceLayout, IdName, ProgramSource } from '../../../src/shared/types';

export function baseName(path: string | undefined): string {
  if (!path) return '';
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return index >= 0 ? path.slice(index + 1) : path;
}

/** 去掉扩展名的文件名，用作 .stf 与程序名的匹配键。 */
export function stemOf(path: string): string {
  const file = baseName(path);
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

export function indexById(list: IdName[] | undefined): Map<number, string> {
  const map = new Map<number, string>();
  for (const item of list ?? []) {
    map.set(item.id, item.name);
  }
  return map;
}

/** 找不到名称时给出可见的占位，避免空单元格让人误以为没有值。 */
export function nameFromIndex(index: Map<number, string>, id: number): string {
  const name = index.get(id);
  if (name !== undefined) return name;
  return id === 0 ? '—' : `#${id}`;
}

export function firstId(list: IdName[] | undefined): number {
  return list?.[0]?.id ?? 0;
}

/**
 * 程序正文只存在于 device.programs（ProgramSource 没有 id/name 字段），
 * 因此用 .stf 文件名去扩展名后的程序名匹配。同名时优先取存在的文件。
 */
export function buildSourceIndex(devices: DeviceLayout[]): Map<string, ProgramSource> {
  const index = new Map<string, ProgramSource>();
  for (const device of devices) {
    for (const source of device.programs) {
      if (!source.path) continue;
      const key = stemOf(source.path).toLowerCase();
      if (!key) continue;
      const existing = index.get(key);
      if (!existing || (existing.missing && !source.missing)) {
        index.set(key, source);
      }
    }
  }
  return index;
}
