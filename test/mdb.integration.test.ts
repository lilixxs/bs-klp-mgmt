import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { JetBridge } from '../src/mdb/jet.ts';
import type { DbOperation, VariableRow } from '../src/shared/types.ts';
import { cleanup, createFixtureDatabase, createWorkspace, helperScript, sampleRows } from './support/fixture.ts';

let workDir: string;
let dbPath: string;
let bridge: JetBridge;

function variableRow(overrides: Partial<VariableRow> = {}): VariableRow {
  return {
    name: 'TEMP_01',
    comment: '测试变量',
    alias: '',
    varInstanceId: 1,
    resourcePouId: 1,
    scopeId: 1,
    defTypeId: 1,
    stringSize: 0,
    attributeId: 2,
    directionId: 2,
    groupId: 2,
    userAddress: '',
    wiring: '',
    isRetain: false,
    order: 30,
    hasDimension: false,
    initialValue: '',
    refLibrary: null,
    hook: null,
    crcInitValueDim: 1,
    crcInitValueType: 204566476,
    status: '',
    ...overrides,
  };
}

describe('Jet 数据库桥（合成数据）', () => {
  before(async () => {
    workDir = await createWorkspace();
    dbPath = await createFixtureDatabase(workDir, sampleRows());
    bridge = new JetBridge(helperScript);
  });

  after(async () => {
    await cleanup(workDir);
  });

  test('读取变量、程序、通讯与物理 I/O', async () => {
    const snapshot = await bridge.snapshot(dbPath);
    assert.equal(snapshot.dbProjectName, 'DEMO_1');
    assert.equal(snapshot.variables.length, 2);
    const hb01 = snapshot.variables.find((variable) => variable.name === 'HB01');
    assert.ok(hb01);
    assert.equal(hb01.comment, '心跳位');
    assert.equal(hb01.userAddress, '9c41');
    assert.equal(snapshot.programs.length, 1);
    assert.equal(snapshot.programs[0]?.name, 'MAIN');
    assert.equal(snapshot.channels[0]?.name, 'COM1CH');
    assert.equal(snapshot.devices[0]?.modbus?.station, 1);
    assert.equal(snapshot.maps.length, 1);
    assert.equal(snapshot.maps[0]?.address, '400001');
    assert.equal(snapshot.ioBindings.length, 1);
    assert.equal(snapshot.groups.length, 2);
    assert.equal(snapshot.definitionTypes.find((type) => type.name === 'REAL')?.crc, 204566476);
  });

  test('新增、改名、删除变量（同一事务）', async () => {
    const before = await bridge.snapshot(dbPath);
    const ops: DbOperation[] = [
      { op: 'variable.insert', tempId: 'v1', row: variableRow() },
      {
        op: 'variable.update',
        id: 2,
        row: variableRow({ name: 'HB01_RENAMED', comment: '心跳位（改名）', defTypeId: 2, crcInitValueType: 164937643, order: 20, userAddress: '9c41', groupId: 2 }),
      },
      { op: 'variable.delete', id: 1 },
    ];
    const result = await bridge.apply(dbPath, ops);
    assert.ok(result.ids['v1'] !== undefined && result.ids['v1'] > 2, '新增变量应获得自增 ID');
    const snapshot = result.snapshot;
    assert.equal(snapshot.variables.length, before.variables.length);
    assert.equal(snapshot.variables.find((variable) => variable.name === 'TEMP_01')?.comment, '测试变量');
    assert.equal(snapshot.variables.find((variable) => variable.name === 'HB01_RENAMED')?.comment, '心跳位（改名）');
    assert.equal(snapshot.variables.some((variable) => variable.name === 'AI_01'), false);
    // 数据库层不级联删除物理 I/O 绑定；业务层（plan）会阻止删除仍然绑定 I/O 的变量。
    assert.equal(snapshot.ioBindings.length, 1);
  });

  test('新增程序、通道、设备与映射，并解析临时引用', async () => {
    const ops: DbOperation[] = [
      {
        op: 'program.insert',
        tempId: 'p1',
        row: {
          name: 'SUB_01',
          comment: '子程序',
          languageId: 1,
          resourceId: 1,
          order: 2,
          readOnly: false,
          generateSymbMon: true,
          refLocalization: 0,
          refPouGroup: 0,
          generateDebugInfo: false,
          is1499: false,
        },
      },
      {
        op: 'channel.insert',
        tempId: 'c1',
        row: {
          id: 2,
          portNum: 2,
          name: 'COM2CH',
          protocol: 'MODBUS',
          interval: 1000,
          timeout: 3000,
          retry: 2,
          watchtime: 10,
          destIp: '10.0.0.1',
          destPort: 502,
          tcpudp: 1,
          baudrate: '19200',
          databits: '8',
          parity: 'E',
          stopbits: '1',
          comments: '',
        },
      },
      {
        op: 'device.insert',
        tempId: 'd1',
        row: {
          id: 2000,
          channelRef: { kind: 'new', tempId: 'c1' },
          name: 'SLAVE2',
          protocol: 'MODBUS',
          interval: 0,
          comments: '测试设备',
          modbus: {
            transMode: 0,
            station: 7,
            transDelay: 5,
            shortFormat: 0,
            longFormat: 0,
            floatFormat: 0,
            longLongFormat: 0,
            doubleFloatFormat: 0,
            singleCmg: 0,
            boolBlockSize: 1024,
            regBlockSize: 200,
            reserved1: 2,
          },
        },
      },
      {
        op: 'map.insert',
        tempId: 'm1',
        row: {
          id: 2,
          deviceRef: { kind: 'new', tempId: 'd1' },
          symbolRef: { kind: 'existing', id: 2 },
          address: '400010',
          access: 1,
        },
      },
    ];
    const result = await bridge.apply(dbPath, ops);
    const snapshot = result.snapshot;
    assert.equal(snapshot.programs.some((program) => program.name === 'SUB_01'), true);
    assert.equal(snapshot.channels.some((channel) => channel.name === 'COM2CH'), true);
    const device = snapshot.devices.find((item) => item.name === 'SLAVE2');
    assert.ok(device);
    assert.equal(device.channelId, 2);
    assert.equal(device.modbus?.station, 7);
    assert.equal(snapshot.maps.some((map) => map.address === '400010' && map.deviceId === 2000), true);
  });

  test('重复变量名导致整批回滚', async () => {
    const before = await bridge.snapshot(dbPath);
    await assert.rejects(
      bridge.apply(dbPath, [{ op: 'variable.insert', tempId: 'dup', row: variableRow({ name: 'TEMP_01' }) }]),
      /duplicate|index|键/i,
    );
    const afterRollback = await bridge.snapshot(dbPath);
    assert.equal(afterRollback.variables.length, before.variables.length);
  });

  test('删除不存在的对象会回滚整批', async () => {
    const before = await bridge.snapshot(dbPath);
    await assert.rejects(
      bridge.apply(dbPath, [
        {
          op: 'channel.update',
          id: 1,
          row: {
            name: 'RENAMED',
            portNum: 1,
            protocol: 'MODBUS',
            interval: 500,
            timeout: 2000,
            retry: 1,
            watchtime: 5,
            destIp: '',
            destPort: 0,
            tcpudp: 0,
            baudrate: '9600',
            databits: '8',
            parity: 'N',
            stopbits: '1',
            comments: '',
          },
        },
        { op: 'variable.delete', id: 9999 },
      ]),
      /affected 0 rows/,
    );
    const afterRollback = await bridge.snapshot(dbPath);
    assert.equal(afterRollback.channels[0]?.name, before.channels[0]?.name);
  });

  test('只读读取不改变数据库文件', async () => {
    const fileBefore = await readFile(dbPath);
    await bridge.snapshot(dbPath);
    const fileAfter = await readFile(dbPath);
    assert.equal(createHash('sha256').update(fileBefore).digest('hex'), createHash('sha256').update(fileAfter).digest('hex'));
  });

  test('存在 System.mdw 时使用临时副本，不存在时直接打开', async (t) => {
    const probe = await bridge.probe(dbPath);
    if (!probe.systemDb) {
      // 干净 Windows（无 Office/ACE）没有可复制的 System.mdw；Jet 直接打开数据库。
      // 其余用例已覆盖该路径下的读写，这里不把“必定有工作组”当作普遍前提。
      t.diagnostic('本机没有 System.mdw，跳过临时副本断言');
      return;
    }
    const resolved = path.resolve(probe.systemDb);
    const tempRoot = path.resolve(process.env['TEMP'] ?? process.env['TMP'] ?? '/tmp');
    assert.equal(resolved.startsWith(tempRoot), true, '工作组应位于临时目录');
    assert.equal(path.basename(resolved).toLowerCase(), 'klp-system.mdw', '应使用复制的临时工作组，而不是用户共享文件');
  });
});
