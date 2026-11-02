import { realpath } from 'node:fs/promises';
import * as path from 'node:path';

function key(value: string): string {
  return path.resolve(value).replace(/\//g, '\\').toLowerCase();
}

/**
 * 求目标路径的物理位置。目标可能尚不存在（新增程序文件），此时沿最近的已存在父目录
 * 求 realpath，再拼回缺失段。这样 junction/symlink 指向工程外时，目标物理位置也会暴露。
 */
export async function physicalPath(target: string): Promise<string> {
  const resolved = path.resolve(target);
  const missing: string[] = [];
  let cursor = resolved;
  for (;;) {
    try {
      const real = await realpath(cursor);
      return path.join(real, ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 只有“确实不存在”才允许沿父目录上溯；EACCES/EPERM/ELOOP 等表示无法验证，
      // 必须报错而不是退回词法路径，否则 junction 的物理越界会被判成安全。
      if (code !== 'ENOENT') {
        throw new Error(`无法解析物理路径 ${cursor}：${error instanceof Error ? error.message : String(error)}`);
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return resolved;
      }
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function samePhysicalPath(a: string, b: string): boolean {
  return key(a) === key(b);
}

export function isInside(rootPhysical: string, candidatePhysical: string): boolean {
  const root = key(rootPhysical);
  const target = key(candidatePhysical);
  if (root === target) {
    return true;
  }
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** 返回 undefined 表示在物理根内；否则返回可读的越界说明。 */
export async function pathOutsideReason(rootPhysical: string, target: string, label: string): Promise<string | undefined> {
  let physical: string;
  try {
    physical = await physicalPath(target);
  } catch (error) {
    return `${label} 的物理位置无法验证，已按越界处理：${target}：${error instanceof Error ? error.message : String(error)}`;
  }
  if (isInside(rootPhysical, physical)) {
    return undefined;
  }
  return `${label} 物理位置越出工程根目录：${target} -> ${physical}`;
}

export function isUnsafeDataDirName(dataDir: string): boolean {
  if (!dataDir || dataDir === '.' || dataDir === '..') {
    return true;
  }
  if (path.isAbsolute(dataDir) || /^[A-Za-z]:/.test(dataDir) || dataDir.startsWith('\\\\')) {
    return true;
  }
  return dataDir.includes('/') || dataDir.includes('\\');
}
