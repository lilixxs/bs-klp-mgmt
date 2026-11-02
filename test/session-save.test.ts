import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { JetBridge } from '../src/mdb/jet.ts';
import { buildPlan } from '../src/project/plan.ts';
import { saveProject, SaveConflictError } from '../src/project/save.ts';
import { openProject } from '../src/project/session.ts';
import type { ChannelInput, CommDeviceInput, Draft, ProjectSnapshot, VariableInput } from '../src/shared/types.ts';
import { decodeText, encodeText } from '../src/util/encoding.ts';
import { cleanup, createWorkspace, helperScript } from './support/fixture.ts';
import { createSyntheticProject, type SyntheticProject } from './support/synthetic-project.ts';

let workDir: string;
let project: SyntheticProject;
let bridge: JetBridge;
let snapshot: ProjectSnapshot;

function variableInput(overrides: Partial<VariableInput> = {}): VariableInput {
  return {
    name: 'HB01',
    comment: '心跳位',
    groupId: 2,
    defTypeId: 2,
    directionId: 2,
    attributeId: 2,
    varInstanceId: 1,
    resourcePouId: 1,
    scopeId: 1,
    userAddress: '9c41',
    wiring: '',
    isRetain: false,
    initialValue: '',
    ...overrides,
  };
}

async function apply(draft: Draft, force = false): Promise<ProjectSnapshot> {
  const result = await saveProject({ snapshot, draft, bridge, force });
  snapshot = result.snapshot;
  return result.snapshot;
}

const channel: ChannelInput = {
  name: 'COM1CH2',
  portNum: 1,
  protocol: 'MODBUS',
  interval: 1000,
  timeout: 3000,
  retry: 2,
  watchtime: 10,
  destIp: '',
  destPort: 0,
  tcpudp: 0,
  baudrate: '19200',
  databits: '8',
  parity: 'E',
  stopbits: '1',
  comments: '',
};

function deviceInput(channelRef: CommDeviceInput['channelRef']): CommDeviceInput {
  return {
    name: 'SLAVE2',
    channelRef,
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
  };
}

describe('打开、编辑、保存与失败保护（合成工程）', () => {
  before(async () => {
    workDir = await createWorkspace();
    project = await createSyntheticProject(workDir);
    bridge = new JetBridge(helperScript);
    snapshot = await openProject(project.entryPath, bridge);
  });

  after(async () => {
    await cleanup(workDir);
  });

  test('打开工程：设备、数据库和 ST 源文件', () => {
    assert.equal(snapshot.project.name, 'DEMO');
    assert.ok(snapshot.db);
    assert.equal(snapshot.db?.variables.length, 2);
    assert.equal(snapshot.devices[0]?.programs[0]?.text?.includes('HB01 := HB01 + 1;'), true);
    assert.equal(snapshot.diagnostics.filter((item) => item.severity === 'error').length, 0);
  });

  test('变量改名同步更新 ST 引用并保持 GBK', async () => {
    const draft: Draft = {
      ops: [
        {
          kind: 'variable.update',
          id: 2,
          input: variableInput({ name: 'COUNT01', comment: '心跳计数' }),
        },
      ],
    };
    const plan = buildPlan({ snapshot, draft });
    assert.equal(plan.canSave, true, plan.diagnostics.map((item) => item.message).join('\n'));
    assert.equal(plan.programWrites.length, 1);
    const updated = await apply(draft);
    assert.equal(updated.db?.variables.find((variable) => variable.id === 2)?.name, 'COUNT01');
    const bytes = await readFile(project.stPath);
    const decoded = decodeText(new Uint8Array(bytes));
    assert.equal(decoded.encoding, 'gbk');
    assert.equal(decoded.text.includes('COUNT01 := COUNT01 + 1;'), true);
    assert.equal(decoded.text.includes('中文注释：心跳计数'), true);
    assert.equal(decoded.text.includes('HB01'), false);
  });

  test('新增变量后可以删除未引用变量', async () => {
    await apply({ ops: [{ kind: 'variable.add', tempId: 'v1', input: variableInput({ name: 'TEMP_01', comment: '临时' }) }] });
    const created = snapshot.db?.variables.find((variable) => variable.name === 'TEMP_01');
    assert.ok(created);
    assert.notEqual(created.order, undefined);
    await apply({ ops: [{ kind: 'variable.delete', id: created.id }] });
    assert.equal(snapshot.db?.variables.some((variable) => variable.name === 'TEMP_01'), false);
  });

  test('删除仍被引用的变量会被阻止', () => {
    const plan = buildPlan({ snapshot, draft: { ops: [{ kind: 'variable.delete', id: 2 }] } });
    assert.equal(plan.canSave, false);
    assert.match(plan.diagnostics.map((item) => item.message).join('\n'), /通讯映射/);
  });

  test('新增 ST 程序、改名并删除源文件', async () => {
    await apply({ ops: [{ kind: 'program.add', tempId: 'p1', input: { name: 'SUB', comment: '', languageId: 1, resourceId: 1 } }] });
    const created = snapshot.db?.programs.find((program) => program.name === 'SUB');
    assert.ok(created);
    assert.equal(created.refLocalization, 4, '新增程序应克隆同资源现有 ST 程序的 RefLocalization');
    const stPath = path.join(project.dir, 'ECP_1', 'Config1', 'Resource1', 'SUB.stf');
    const text = decodeText(new Uint8Array(await readFile(stPath))).text;
    assert.equal(text.startsWith('PROGRAM SUB\r\n'), true);
    assert.equal(text.includes('END_PROGRAM'), true);

    await apply({ ops: [{ kind: 'program.update', id: created.id, input: { name: 'SUB2', comment: '改名', languageId: 1, resourceId: 1 } }] });
    assert.equal((await stat(stPath).catch(() => undefined))?.isFile(), undefined);
    const renamedPath = path.join(project.dir, 'ECP_1', 'Config1', 'Resource1', 'SUB2.stf');
    const renamedText = decodeText(new Uint8Array(await readFile(renamedPath))).text;
    assert.equal(renamedText.startsWith('PROGRAM SUB2'), true);
    assert.equal(snapshot.db?.programs.find((program) => program.id === created.id)?.refLocalization, 4);

    const beforeComment = new Uint8Array(await readFile(renamedPath));
    await apply({ ops: [{ kind: 'program.update', id: created.id, input: { name: 'SUB2', comment: '只改注释', languageId: 1, resourceId: 1 } }] });
    const afterComment = new Uint8Array(await readFile(renamedPath));
    assert.deepEqual(afterComment, beforeComment, '只改注释不应重写源文件');

    await apply({ ops: [{ kind: 'program.delete', id: created.id }] });
    assert.equal(snapshot.db?.programs.some((program) => program.name === 'SUB2'), false);
    assert.equal((await stat(renamedPath).catch(() => undefined))?.isFile(), undefined);
  });

  test('通讯对象增删与引用阻止', async () => {
    await apply({ ops: [{ kind: 'channel.add', tempId: 'c1', input: channel }] });
    const savedChannel = snapshot.db?.channels.find((item) => item.name === 'COM1CH2');
    assert.ok(savedChannel);
    await apply({ ops: [{ kind: 'device.add', tempId: 'd1', input: deviceInput({ kind: 'existing', id: savedChannel.id }) }] });
    const device = snapshot.db?.devices.find((item) => item.name === 'SLAVE2');
    assert.ok(device);
    await apply({ ops: [{ kind: 'map.add', tempId: 'm1', input: { deviceRef: { kind: 'existing', id: device.id }, symbolRef: { kind: 'existing', id: 2 }, address: '400010', access: 1 } }] });
    assert.equal(snapshot.db?.maps.some((map) => map.address === '400010' && map.deviceId === device.id), true);

    const blocked = buildPlan({ snapshot, draft: { ops: [{ kind: 'device.delete', id: device.id }] } });
    assert.equal(blocked.canSave, false);
    assert.match(blocked.diagnostics.map((item) => item.message).join('\n'), /变量映射/);

    const map = snapshot.db?.maps.find((item) => item.address === '400010');
    assert.ok(map);
    const channelId = snapshot.db?.channels.find((item) => item.name === 'COM1CH2')?.id;
    assert.ok(channelId);
    await apply({
      ops: [
        { kind: 'map.delete', id: map.id },
        { kind: 'device.delete', id: device.id },
        { kind: 'channel.delete', id: channelId },
      ],
    });
    assert.equal(snapshot.db?.devices.some((item) => item.name === 'SLAVE2'), false);
    assert.equal(snapshot.db?.channels.some((item) => item.name === 'COM1CH2'), false);
  });

  test('外部修改导致保存冲突', async () => {
    const stPath = path.join(project.dir, 'ECP_1', 'Config1', 'Resource1', 'MAIN.stf');
    const original = await readFile(stPath);
    const decoded = decodeText(new Uint8Array(original));
    await writeFile(stPath, encodeText(`${decoded.text}\r\n// 外部修改\r\n`, decoded.encoding));
    const draft: Draft = { ops: [{ kind: 'variable.update', id: 2, input: variableInput({ name: 'COUNT01', comment: '被外部改动' }) }] };
    await assert.rejects(saveProject({ snapshot, draft, bridge }), SaveConflictError);
    await writeFile(stPath, new Uint8Array(original));
  });

  test('数据库不可替换时回滚已写入的源文件', async () => {
    const beforeHash = createHash('sha256').update(await readFile(project.dbPath)).digest('hex');
    const newSt = path.join(project.dir, 'ECP_1', 'Config1', 'Resource1', 'FAIL.stf');
    await chmod(project.dbPath, 0o444);
    try {
      await assert.rejects(
        saveProject({
          snapshot,
          draft: {
            ops: [
              { kind: 'program.add', tempId: 'pf', input: { name: 'FAIL', comment: '', languageId: 1, resourceId: 1 } },
              { kind: 'variable.add', tempId: 'vf', input: variableInput({ name: 'FAIL_VAR' }) },
            ],
          },
          bridge,
        }),
      );
    } finally {
      await chmod(project.dbPath, 0o666);
    }
    assert.equal((await stat(newSt).catch(() => undefined))?.isFile(), undefined, '失败后不应留下新源文件');
    const afterHash = createHash('sha256').update(await readFile(project.dbPath)).digest('hex');
    assert.equal(afterHash, beforeHash);
  });

  test('工程整体改名：目录、.mgp 与属性', async () => {
    await apply({ ops: [{ kind: 'project.rename', newName: 'DEMO2' }] });
    assert.equal(snapshot.project.name, 'DEMO2');
    assert.equal(path.basename(snapshot.projectDir), 'DEMO2');
    assert.equal(path.basename(snapshot.entryPath), 'DEMO2.mgp');
    const xml = await readFile(snapshot.entryPath, 'utf8');
    assert.equal(xml.includes('Name="DEMO2"'), true);
    assert.equal(xml.includes('<DataDir>ECP_1</DataDir>'), true);
    assert.equal((await stat(path.join(snapshot.projectDir, 'ECP_1', 'PrjLibrary.mdb'))).isFile(), true);
    const reopened = await openProject(snapshot.entryPath, bridge);
    assert.equal(reopened.project.name, 'DEMO2');
    assert.equal(reopened.db?.variables.length, snapshot.db?.variables.length);
  });
});

