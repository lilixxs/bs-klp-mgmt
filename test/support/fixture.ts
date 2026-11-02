import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { resolvePowerShellPath } from '../../src/mdb/jet.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const helperScript = path.join(here, '..', '..', 'media', 'mdb-helper.ps1');
const makeFixtureScript = path.join(here, 'make-fixture.ps1');

export interface FixtureTableRows {
  [table: string]: Array<Record<string, unknown>>;
}

export async function createWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'klp-test-'));
}

export async function createFixtureDatabase(dir: string, rows: FixtureTableRows): Promise<string> {
  const dbPath = path.join(dir, 'PrjLibrary.mdb');
  const requestPath = path.join(dir, 'fixture-request.json');
  await writeFile(requestPath, JSON.stringify({ dbPath, rows }), 'utf8');
  await runPowerShell(['-File', makeFixtureScript, '-RequestPath', requestPath]);
  const output = JSON.parse(await readFile(`${requestPath}.out`, 'utf8')) as { ok: boolean; error?: string };
  if (!output.ok) {
    throw new Error(`创建测试数据库失败：${output.error ?? '未知错误'}`);
  }
  return dbPath;
}

function runPowerShell(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePowerShellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`PowerShell 退出码 ${code}：${stderr}`));
      }
    });
  });
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** 合成的 KLP 形状数据：不含任何真实工程、客户或网络信息。 */
export function sampleRows(): FixtureTableRows {
  return {
    Project: [{ Name: 'DEMO_1' }],
    Configurations: [{ Name: 'Config1' }],
    Resources: [{ RefConfiguration: 1, Name: 'Resource1', Address: '@1' }],
    Group: [
      { RefResource: 1, Name: 'BuildInIO', SingleTextLine: '', Order: 1 },
      { RefResource: 1, Name: 'MOD1', SingleTextLine: '', Order: 2 },
    ],
    'Definition type': [
      { Name: 'REAL', RefDataType: 1, StringSize: 0, CRC: 204566476, RefLibrary: null },
      { Name: 'INT', RefDataType: 1, StringSize: 0, CRC: 164937643, RefLibrary: null },
    ],
    VarInstance: [
      { RefVarInstance: 1, Name: 'Variable' },
      { RefVarInstance: 2, Name: 'Instance' },
    ],
    Scopes: [{ Name: 'Global' }],
    Direction: [{ Name: 'Input' }, { Name: 'Internal' }],
    Attributes: [{ Name: 'Read', SingleTextLine: 'Read only' }, { Name: 'Free', SingleTextLine: 'Read and Write' }],
    Languages: [{ Name: 'ST' }],
    POUs: [
      {
        Name: 'MAIN',
        SingleTextLine: null,
        Comment: null,
        RefLanguage: 1,
        RefResource: 1,
        Order: 1,
        RefPOUtype: 1,
        ReadOnly: false,
        GenerateSymbMon: true,
        Encrypted: false,
        RefPOUGroup: 0,
        RefLocalization: 4,
        GenerateDebugInfo: false,
        Is1499: false,
      },
      {
        Name: 'BLINK',
        SingleTextLine: 'blink',
        Comment: null,
        RefLanguage: 1,
        RefResource: 0,
        Order: 0,
        RefPOUtype: 3,
        ReadOnly: false,
        GenerateSymbMon: false,
        Encrypted: false,
      },
    ],
    Programs: [{ RefPOUs: 1, Order: 1, RefFather: 0 }],
    Symbols: [
      {
        Name: 'AI_01',
        SingleTextLine: '水温1',
        Alias: '',
        RefVarInstance: 1,
        RefResourcePOU: 1,
        RefScope: 1,
        RefDefType: 1,
        StringSize: 0,
        RefAttribute: 1,
        RefDirection: 1,
        RefGroup: 1,
        UserAddress: '',
        Wiring: '%IR0.0',
        IsRetain: false,
        Order: 10,
        HasDimension: false,
        InitialValue: '',
        RefLibrary: 0,
        Hook: 0,
        CRCInitValueDim: 1,
        CRCInitValueType: 204566476,
        RefStatus: null,
      },
      {
        Name: 'HB01',
        SingleTextLine: '心跳位',
        Alias: '',
        RefVarInstance: 1,
        RefResourcePOU: 1,
        RefScope: 1,
        RefDefType: 2,
        StringSize: 0,
        RefAttribute: 2,
        RefDirection: 2,
        RefGroup: 2,
        UserAddress: '9c41',
        Wiring: '',
        IsRetain: false,
        Order: 20,
        HasDimension: false,
        InitialValue: '',
        RefLibrary: null,
        Hook: null,
        CRCInitValueDim: 1,
        CRCInitValueType: 164937643,
        RefStatus: null,
      },
    ],
    'I/O Symbols': [{ RefSymbols: 1, RefInstance: 8, RefDevice: 248, PhysicalOrder: 0, Order: 0 }],
    GWChannel: [
      {
        RefChannel: 1,
        PortNum: 1,
        Name: 'COM1CH',
        Protocol: 'MODBUS',
        Interval: 500,
        Timeout: 2000,
        Retry: 1,
        Watchtime: 5,
        DestIP: '',
        DestPort: 0,
        Tcpudp: 0,
        Baudrate: '9600',
        Databits: '8',
        Parity: 'N',
        Stopbits: '1',
        Reserved1: 0,
        Reserved2: 0,
        Comments: '',
      },
    ],
    GWDevice: [{ RefDevice: 1000, RefChannel: 1, Name: 'SLAVE1', Protocol: 'MODBUS', Interval: 0, Reserved1: 0, Comments: '' }],
    GWDeviceModbus: [
      {
        RefDevice: 1000,
        TransMode: 0,
        Station: 1,
        TransDelay: 10,
        ShortFormat: 0,
        LongFormat: 1,
        FloatFormat: 1,
        LongLongFormat: 0,
        DoubleFloatFormat: 0,
        SingleCmg: 0,
        BoolBlockSize: 1024,
        RegBlockSize: 200,
        Reserved1: 2,
        Reserved2: null,
      },
    ],
    GWVariableMap: [{ RefVariable: 1, RefDevice: 1000, RefSymbol: 2, Address: '400001', Access: 1 }],
  };
}
