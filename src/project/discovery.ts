import * as path from 'node:path';
import { stat } from 'node:fs/promises';
import { listDirectory } from '../util/fsx.ts';

export interface EntryCandidate {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
}

export class ProjectOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectOpenError';
  }
}

/** 找出可作为项目入口的 *.mgp 文件。传入目录时返回目录下所有候选。 */
export async function discoverEntries(inputPath: string): Promise<EntryCandidate[]> {
  const info = await stat(inputPath).catch(() => undefined);
  if (!info) {
    throw new ProjectOpenError(`路径不存在：${inputPath}`);
  }
  if (info.isFile()) {
    if (!inputPath.toLowerCase().endsWith('.mgp')) {
      throw new ProjectOpenError('请选择 KLP 项目的 .mgp 入口文件，或包含该文件的工程文件夹。');
    }
    return [{ path: inputPath, name: path.basename(inputPath), size: info.size, mtimeMs: info.mtimeMs }];
  }
  const names = (await listDirectory(inputPath)).filter((name) => name.toLowerCase().endsWith('.mgp'));
  const candidates: EntryCandidate[] = [];
  for (const name of names) {
    const full = path.join(inputPath, name);
    const entryInfo = await stat(full).catch(() => undefined);
    if (entryInfo?.isFile()) {
      candidates.push({ path: full, name, size: entryInfo.size, mtimeMs: entryInfo.mtimeMs });
    }
  }
  return candidates.sort((a, b) => a.name.localeCompare(b.name));
}
