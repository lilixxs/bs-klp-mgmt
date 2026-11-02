import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { FileStamp } from '../shared/types.ts';

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

export async function listDirectory(target: string): Promise<string[]> {
  try {
    return await readdir(target);
  } catch {
    return [];
  }
}

/** 大小写不敏感地查找目录项（KLP 工程来自 Windows，大小写可能不一致）。 */
export async function findEntry(dir: string, name: string): Promise<string | undefined> {
  const entries = await listDirectory(dir);
  const lower = name.toLowerCase();
  const hit = entries.find((entry) => entry.toLowerCase() === lower);
  return hit ? path.join(dir, hit) : undefined;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function stampFile(filePath: string): Promise<FileStamp> {
  const [bytes, info] = await Promise.all([readFile(filePath), stat(filePath)]);
  return {
    path: filePath,
    size: info.size,
    mtimeMs: info.mtimeMs,
    sha256: sha256(bytes),
  };
}

export async function readBytes(filePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(filePath));
}

/** 原子写：先写同目录临时文件，再替换目标。用于 .stf / .mgp 等文本文件。 */
export async function writeFileAtomic(filePath: string, bytes: Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(filePath)}.klp-tmp-${process.pid}-${Date.now()}`);
  try {
    await writeFile(temp, bytes);
    await rename(temp, filePath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

export function relativeInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
