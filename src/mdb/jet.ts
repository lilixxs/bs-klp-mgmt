import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { DbOperation, DbSnapshot } from '../shared/types.ts';

export class JetUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JetUnavailableError';
  }
}

export class JetError extends Error {
  readonly stage?: string;

  constructor(message: string, stage?: string) {
    super(message);
    this.name = 'JetError';
    this.stage = stage;
  }
}

interface HelperResponse {
  ok?: boolean;
  stage?: string;
  error?: string;
  systemDb?: string;
  data?: unknown;
  ids?: Record<string, number>;
  counts?: Record<string, number>;
}

export interface JetApplyResult {
  ids: Record<string, number>;
  counts: Record<string, number>;
  snapshot: DbSnapshot;
}

/** 解析 32 位 Windows PowerShell；Jet 4.0 只有 32 位版本。 */
export function resolvePowerShellPath(): string {
  const root = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows';
  const candidate = path.join(root, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(candidate) ? candidate : 'powershell.exe';
}

/** 默认的 Jet 工作组文件（Windows 自带 Jet 首次使用时创建）。 */
export function resolveSystemWorkgroup(): string | undefined {
  // 优先使用 Windows 自带的干净工作组模板。APPDATA 下的 System.mdw 可能正被 KLP 等
  // 32 位 Jet 进程占用或写入锁页，复制带锁页的工作组会导致 “Not a valid password”。
  const candidates = [
    path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'SysWOW64', 'system.mdw'),
    path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'system.mdw'),
    process.env['APPDATA'] ? path.join(process.env['APPDATA'], 'Microsoft', 'Access', 'System.mdw') : undefined,
  ].filter((item): item is string => Boolean(item));
  return candidates.find((item) => existsSync(item));
}

/**
 * 通过随扩展分发的 PowerShell 脚本访问 KLP 的 Jet 3 数据库。
 * 脚本与扩展之间只交换 UTF-8 JSON，避免控制台代码页与命令行转义问题。
 *
 * 每次调用都在临时目录复制一份工作组文件：Jet 会把数据库锁写入工作组，
 * 复用用户共享的 System.mdw 会因残留锁导致 "Not a valid password"。
 */
export class JetBridge {
  private readonly helperScript: string;
  private readonly workgroupSource?: string;
  private readonly timeoutMs: number;

  constructor(helperScript: string, workgroupSource?: string, timeoutMs = 120_000) {
    this.helperScript = helperScript;
    this.workgroupSource = workgroupSource ?? resolveSystemWorkgroup();
    this.timeoutMs = timeoutMs;
  }

  async probe(dbPath: string): Promise<{ provider: string; version: string; systemDb?: string }> {
    const response = await this.run({ action: 'probe', dbPath });
    return response as { provider: string; version: string; systemDb?: string };
  }

  async snapshot(dbPath: string): Promise<DbSnapshot> {
    const response = await this.run({ action: 'snapshot', dbPath });
    return response as DbSnapshot;
  }

  async apply(dbPath: string, ops: DbOperation[]): Promise<JetApplyResult> {
    const response = await this.run({ action: 'apply', dbPath, ops });
    return response as JetApplyResult;
  }

  private async run(request: Record<string, unknown>): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.runOnce(request);
      } catch (error) {
        lastError = error;
        // 工作组复制/系统 mdw 偶发锁定会在 open 阶段报 "Not a valid password"。
        // 该阶段尚未执行任何事务，换一个全新临时工作组重试是安全的。
        const retryable =
          error instanceof JetError &&
          error.stage === 'open' &&
          /Not a valid password|Unable to open database/i.test(error.message);
        if (!retryable || attempt === 2) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private async runOnce(request: Record<string, unknown>): Promise<unknown> {
    if (!existsSync(this.helperScript)) {
      throw new JetUnavailableError(`缺少数据库助手脚本：${this.helperScript}`);
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'klp-jet-'));
    const requestPath = path.join(dir, 'request.json');
    const responsePath = path.join(dir, 'response.json');
    const payload: Record<string, unknown> = { ...request };
    if (this.workgroupSource) {
      const workgroup = path.join(dir, 'klp-system.mdw');
      try {
        await copyFile(this.workgroupSource, workgroup);
        payload['workgroupPath'] = workgroup;
      } catch {
        // 复制失败时退回助手脚本的默认探测顺序。
      }
    }
    try {
      await writeFile(requestPath, JSON.stringify(payload), 'utf8');
      const stderr = await this.spawnHelper(requestPath, responsePath);
      let raw: string;
      try {
        raw = await readFile(responsePath, 'utf8');
      } catch {
        const detail = stderr.trim();
        throw new JetUnavailableError(
          `数据库助手没有返回结果。${detail ? `输出：${detail}` : '可能是系统缺少 32 位 Jet 4.0 组件。'}`,
        );
      }
      let parsed: HelperResponse;
      try {
        parsed = JSON.parse(raw) as HelperResponse;
      } catch {
        throw new JetError(`数据库助手返回了无法解析的结果：${raw.slice(0, 400)}`);
      }
      if (!parsed.ok) {
        const message = parsed.error ?? '未知错误';
        if (/Provider cannot be found|Class not registered|not found/i.test(message)) {
          throw new JetUnavailableError(`无法使用 32 位 Jet 4.0 数据库组件：${message}`);
        }
        throw new JetError(message, parsed.stage);
      }
      const result = parsed.data ?? {};
      if (request['action'] === 'apply') {
        return {
          ids: parsed.ids ?? {},
          counts: parsed.counts ?? {},
          snapshot: result as DbSnapshot,
        } satisfies JetApplyResult;
      }
      if (request['action'] === 'probe') {
        return { ...(result as object), systemDb: parsed.systemDb };
      }
      return result;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private spawnHelper(requestPath: string, responsePath: string): Promise<string> {
    const exe = resolvePowerShellPath();
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.helperScript,
      '-RequestPath',
      requestPath,
      '-ResponsePath',
      responsePath,
    ];
    return new Promise<string>((resolve, reject) => {
      const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new JetError(`数据库操作超时（${this.timeoutMs} 毫秒）。`, 'timeout'));
      }, this.timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new JetUnavailableError(`无法启动数据库助手：${error.message}`));
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(stdout + (stderr ? `\n${stderr}` : ''));
      });
    });
  }
}
