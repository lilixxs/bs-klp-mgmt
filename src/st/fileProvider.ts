import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ProjectSnapshot } from '../shared/types.ts';
import { stBytesForEditor, stBytesFromEditor } from '../util/encoding.ts';
import { readBytes, writeFileAtomic } from '../util/fsx.ts';
import { isAllowedStSourcePath, isWritableStSourcePath } from '../project/stPaths.ts';
import { isInside, physicalPath } from '../project/pathSafety.ts';

export const ST_SCHEME = 'klp-st';

/** 把 `klp-st:` URI 还原为磁盘路径。 */
export function filePathOf(uri: vscode.Uri): string {
  const raw = uri.path;
  if (process.platform === 'win32') {
    return raw.replace(/^\//, '').replace(/\//g, '\\');
  }
  return raw;
}

/** 把磁盘路径包装为 `klp-st:` URI；保留 .stf 后缀以便语言关联。 */
export function uriForFile(filePath: string): vscode.Uri {
  const normalized = filePath.replace(/\\/g, '/');
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return vscode.Uri.from({ scheme: ST_SCHEME, path: withSlash });
}

/**
 * .stf 的虚拟文件系统：
 * 页面上看到的是按 GBK 解码的文本（由 `[klp-st] files.encoding=gbk` 决定），
 * 磁盘上保留原编码；原文件带 UTF-8 BOM 时写回仍带 BOM。
 *
 * 只允许访问当前工程数据库中已注册的 ST 程序源文件，防止任意路径读写。
 */
export class StFileSystemProvider implements vscode.FileSystemProvider {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;

  constructor(private readonly snapshotProvider?: () => ProjectSnapshot | undefined) {}

  private async ensurePhysicalInside(target: string): Promise<void> {
    const snapshot = this.snapshotProvider?.();
    if (!snapshot?.physicalRoot) {
      throw vscode.FileSystemError.NoPermissions(`工程物理根目录未知，拒绝访问：${target}`);
    }
    let physical: string;
    try {
      physical = await physicalPath(target);
    } catch (error) {
      throw vscode.FileSystemError.NoPermissions(
        `路径物理位置无法验证，拒绝访问：${target}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isInside(snapshot.physicalRoot, physical)) {
      throw vscode.FileSystemError.NoPermissions(`路径物理位置越出工程根目录：${target} -> ${physical}`);
    }
  }

  private async ensureAllowed(uri: vscode.Uri, target = filePathOf(uri)): Promise<void> {
    if (!isAllowedStSourcePath(this.snapshotProvider?.(), target)) {
      throw vscode.FileSystemError.NoPermissions(`不允许访问未注册的程序源文件：${target}`);
    }
    await this.ensurePhysicalInside(target);
  }

  private async ensureWritable(uri: vscode.Uri, target = filePathOf(uri)): Promise<void> {
    if (!isWritableStSourcePath(this.snapshotProvider?.(), target)) {
      throw vscode.FileSystemError.NoPermissions(`不允许写入非 ST 或未注册的源文件：${target}`);
    }
    await this.ensurePhysicalInside(target);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const target = filePathOf(uri);
    await this.ensureAllowed(uri, target);
    const content = await this.readFile(uri);
    const info = await vscode.workspace.fs.stat(vscode.Uri.file(target));
    return {
      type: vscode.FileType.File,
      ctime: info.ctime,
      mtime: info.mtime,
      size: content.length,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const target = filePathOf(uri);
    await this.ensureAllowed(uri, target);
    return stBytesForEditor(await readBytes(target));
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const target = filePathOf(uri);
    await this.ensureWritable(uri, target);
    const existing = await readBytes(target).catch(() => undefined);
    await writeFileAtomic(target, stBytesFromEditor(content, existing));
    this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const dir = filePathOf(uri);
    const snapshot = this.snapshotProvider?.();
    const allowedDirs = new Set(
      (snapshot?.devices ?? [])
        .map((device) => device.resourcePath)
        .filter((item): item is string => Boolean(item))
        .map((item) => path.resolve(item).toLowerCase()),
    );
    if (!allowedDirs.has(path.resolve(dir).toLowerCase())) {
      throw vscode.FileSystemError.NoPermissions(`不允许列出目录：${dir}`);
    }
    await this.ensurePhysicalInside(dir);
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    return entries.map(([name, type]) => [name, type]);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    throw vscode.FileSystemError.NoPermissions(`不允许创建目录：${filePathOf(uri)}`);
  }

  async delete(uri: vscode.Uri): Promise<void> {
    throw vscode.FileSystemError.NoPermissions(`不允许通过 klp-st 删除文件：${filePathOf(uri)}`);
  }

  async rename(from: vscode.Uri, to: vscode.Uri): Promise<void> {
    throw vscode.FileSystemError.NoPermissions(
      `不允许通过 klp-st 重命名文件：${filePathOf(from)} → ${filePathOf(to)}`,
    );
  }

  dispose(): void {
    this.changed.dispose();
  }
}

export function stFileName(filePath: string): string {
  return path.basename(filePath).toLowerCase();
}
