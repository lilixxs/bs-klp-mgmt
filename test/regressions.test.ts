import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { JetBridge } from '../src/mdb/jet.ts';
import { buildPlan } from '../src/project/plan.ts';
import { openProject } from '../src/project/session.ts';
import { programHeaderName } from '../src/project/st.ts';
import { isAllowedStSourcePath, isWritableStSourcePath } from '../src/project/stPaths.ts';
import { saveProject, SaveRollbackError } from '../src/project/save.ts';
import type { ChannelInput, CommDeviceInput, Draft, ProjectSnapshot, VariableInput } from '../src/shared/types.ts';
import { decodeStBytes, encodeGbk, stBytesForEditor } from '../src/util/encoding.ts';
import { cleanup, createFixtureDatabase, createWorkspace, helperScript, sampleRows } from './support/fixture.ts';
import { createSyntheticProject, MGP_XML, ST_SOURCE, type SyntheticProject } from './support/synthetic-project.ts';

const bridge = new JetBridge(helperScript);

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

function programInput(name: string): { name: string; comment: string; languageId: number; resourceId: number } {
  return { name, comment: '', languageId: 1, resourceId: 1 };
}

async function hash(target: string): Promise<string> {
  return createHash('sha256').update(await readFile(target)).digest('hex');
}

async function exists(target: string): Promise<boolean> {
  return Boolean(await stat(target).catch(() => undefined));
}

async function stText(target: string): Promise<string> {
  return decodeStBytes(await readFile(target)).text;
}

const channelInput: ChannelInput = {
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
    name: 'SLAVE1',
    channelRef,
    protocol: 'MODBUS',
    interval: 0,
    comments: '',
    modbus: {
      transMode: 0,
      station: 1,
      transDelay: 10,
      shortFormat: 0,
      longFormat: 1,
      floatFormat: 1,
      longLongFormat: 0,
      doubleFloatFormat: 0,
      singleCmg: 0,
      boolBlockSize: 1024,
      regBlockSize: 200,
      reserved1: 2,
    },
  };
}

async function withProject(
  name: string,
  run: (project: SyntheticProject, snapshot: ProjectSnapshot, workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await createWorkspace();
  try {
    const project = await createSyntheticProject(workspace, name);
    const snapshot = await openProject(project.entryPath, bridge);
    await run(project, snapshot, workspace);
  } finally {
    await cleanup(workspace);
  }
}

describe('保存一致性回归（合成工程）', () => {
  test('B1：同一草稿变量后改名 / 程序先改名两种顺序都得到一致最终文件', async () => {
    for (const order of ['variable-first', 'program-first'] as const) {
      await withProject(order, async (project, snapshot) => {
        const variable = {
          kind: 'variable.update' as const,
          id: 2,
          input: variableInput({ name: 'RENAMED' }),
        };
        const program = {
          kind: 'program.update' as const,
          id: 1,
          input: programInput('MAIN2'),
        };
        const draft: Draft = { ops: order === 'variable-first' ? [variable, program] : [program, variable] };
        const plan = buildPlan({ snapshot, draft });
        assert.equal(plan.canSave, true, plan.diagnostics.map((item) => item.message).join('\n'));
        assert.equal(plan.programWrites.length, 1);
        const saved = await saveProject({ snapshot, draft, bridge });
        const newPath = path.join(path.dirname(project.stPath), 'MAIN2.stf');
        assert.equal(await exists(project.stPath), false, `${order}: 旧文件不应复活`);
        const text = await stText(newPath);
        assert.equal(programHeaderName(text), 'MAIN2', `${order}: PROGRAM 头应为新名`);
        assert.equal(/\bHB01\b/.test(text), false, `${order}: 不应残留旧变量`);
        assert.equal(/\bRENAMED\b/.test(text), true, `${order}: 应引用新变量`);
        assert.equal(saved.snapshot.db?.variables.find((item) => item.id === 2)?.name, 'RENAMED');
        assert.equal(
          saved.snapshot.diagnostics.some((item) => item.code === 'program.headerMismatch'),
          false,
        );
      });
    }
  });

  test('B1：连续两次同时改变量名和程序名，最终文件与数据库保持一致', async () => {
    await withProject('continuous', async (project, snapshot) => {
      const first = await saveProject({
        snapshot,
        bridge,
        draft: {
          ops: [
            { kind: 'variable.update', id: 2, input: variableInput({ name: 'STEP1' }) },
            { kind: 'program.update', id: 1, input: programInput('PROG1') },
          ],
        },
      });
      const second = await saveProject({
        snapshot: first.snapshot,
        bridge,
        draft: {
          ops: [
            { kind: 'variable.update', id: 2, input: variableInput({ name: 'STEP2' }) },
            { kind: 'program.update', id: 1, input: programInput('PROG2') },
          ],
        },
      });
      const finalPath = path.join(path.dirname(project.stPath), 'PROG2.stf');
      const text = await stText(finalPath);
      assert.equal(programHeaderName(text), 'PROG2');
      assert.equal(/\bSTEP2\b/.test(text), true);
      assert.equal(/\bSTEP1\b/.test(text), false);
      assert.equal(await exists(path.join(path.dirname(project.stPath), 'PROG1.stf')), false);
      assert.equal(await exists(project.stPath), false);
      assert.equal(second.snapshot.db?.variables.find((item) => item.id === 2)?.name, 'STEP2');
      assert.equal(second.snapshot.db?.programs.find((item) => item.id === 1)?.name, 'PROG2');
    });
  });

  test('B2：工程改名目标已存在时，数据库、源码和入口都不变', async () => {
    await withProject('target-exists', async (project, snapshot, workspace) => {
      const target = path.join(workspace, 'TAKEN');
      await mkdir(target);
      const dbBefore = await hash(project.dbPath);
      const stBefore = await hash(project.stPath);
      const entryBefore = await hash(project.entryPath);
      await assert.rejects(
        saveProject({
          snapshot,
          bridge,
          draft: {
            ops: [
              { kind: 'variable.update', id: 2, input: variableInput({ name: 'RENAMED' }) },
              { kind: 'project.rename', newName: 'TAKEN' },
            ],
          },
        }),
        /目标目录已存在/,
      );
      assert.equal(await hash(project.dbPath), dbBefore);
      assert.equal(await hash(project.stPath), stBefore);
      assert.equal(await hash(project.entryPath), entryBefore);
      assert.equal((await openProject(project.entryPath, bridge)).db?.variables.find((item) => item.id === 2)?.name, 'HB01');
      assert.equal(await stText(project.stPath).then((text) => /\bHB01\b/.test(text)), true);
    });
  });

  test('B2：数据库提交后发生故障时恢复数据库、源码和入口', async () => {
    await withProject('after-db', async (project, snapshot) => {
      const dbBefore = await hash(project.dbPath);
      const stBefore = await hash(project.stPath);
      const entryBefore = await hash(project.entryPath);
      await assert.rejects(
        saveProject({
          snapshot,
          bridge,
          hooks: {
            afterDatabaseApply: () => {
              throw new Error('fault-after-db');
            },
          },
          draft: {
            ops: [
              { kind: 'variable.update', id: 2, input: variableInput({ name: 'RENAMED' }) },
              { kind: 'program.update', id: 1, input: programInput('MAIN2') },
              { kind: 'project.rename', newName: 'RENAMED_PROJECT' },
            ],
          },
        }),
        /fault-after-db/,
      );
      assert.equal(await hash(project.dbPath), dbBefore);
      assert.equal(await hash(project.stPath), stBefore);
      assert.equal(await hash(project.entryPath), entryBefore);
      assert.equal(await exists(project.stPath), true);
      assert.equal(await exists(path.join(path.dirname(project.stPath), 'MAIN2.stf')), false);
      const reopened = await openProject(project.entryPath, bridge);
      assert.equal(reopened.project.name, 'after-db');
      assert.equal(reopened.db?.variables.find((item) => item.id === 2)?.name, 'HB01');
      assert.equal(await exists(path.join(path.dirname(project.dir), 'RENAMED_PROJECT')), false);
    });
  });

  test('B2：源文件写入后发生故障时数据库不被提交且文件恢复', async () => {
    await withProject('after-files', async (project, snapshot) => {
      const dbBefore = await hash(project.dbPath);
      const stBefore = await hash(project.stPath);
      await assert.rejects(
        saveProject({
          snapshot,
          bridge,
          hooks: {
            afterProgramFiles: () => {
              throw new Error('fault-after-files');
            },
          },
          draft: {
            ops: [
              { kind: 'variable.update', id: 2, input: variableInput({ name: 'RENAMED' }) },
              { kind: 'variable.add', tempId: 'v1', input: variableInput({ name: 'NEW_VAR' }) },
            ],
          },
        }),
        /fault-after-files/,
      );
      assert.equal(await hash(project.dbPath), dbBefore);
      assert.equal(await hash(project.stPath), stBefore);
      assert.equal((await bridge.snapshot(project.dbPath)).variables.some((item) => item.name === 'NEW_VAR'), false);
    });
  });

  test('B2：工程目录已改名后故障，目录、入口、数据库和源码全部回滚', async () => {
    await withProject('after-commit', async (project, snapshot, workspace) => {
      const dbBefore = await hash(project.dbPath);
      const stBefore = await hash(project.stPath);
      const entryBefore = await hash(project.entryPath);
      await assert.rejects(
        saveProject({
          snapshot,
          bridge,
          hooks: {
            afterCommit: () => {
              throw new Error('fault-after-commit');
            },
          },
          draft: {
            ops: [
              { kind: 'variable.update', id: 2, input: variableInput({ name: 'RENAMED' }) },
              { kind: 'program.update', id: 1, input: programInput('MAIN2') },
              { kind: 'project.rename', newName: 'RENAMED_PROJECT' },
            ],
          },
        }),
        /fault-after-commit/,
      );
      assert.equal(await exists(project.dir), true);
      assert.equal(await exists(path.join(workspace, 'RENAMED_PROJECT')), false);
      assert.equal(await hash(project.dbPath), dbBefore);
      assert.equal(await hash(project.stPath), stBefore);
      assert.equal(await hash(project.entryPath), entryBefore);
      assert.equal(await exists(path.join(path.dirname(project.stPath), 'MAIN2.stf')), false);
    });
  });

  test('目录回滚失败时不再向旧路径写入，抛出可恢复现场错误', async () => {
    await withProject('rollback-blocked', async (project, snapshot, workspace) => {
      await assert.rejects(
        saveProject({
          snapshot,
          bridge,
          hooks: {
            afterCommit: () => {
              throw new Error('fault-after-commit');
            },
            beforeRollback: async () => {
              await writeFile(project.dir, 'block old path');
            },
          },
          draft: {
            ops: [
              { kind: 'variable.update', id: 2, input: variableInput({ name: 'RENAMED' }) },
              { kind: 'project.rename', newName: 'ROLLBACK_BLOCKED' },
            ],
          },
        }),
        (error) => {
          assert.equal(error instanceof SaveRollbackError, true);
          assert.match(error.message, /回滚没有完全恢复|现场保留/);
          assert.match(error.rollbackErrors.join('\n'), /数据库改动未回滚/);
          return true;
        },
      );
      assert.equal(await exists(path.join(workspace, 'ROLLBACK_BLOCKED')), true);
      assert.equal(await exists(path.join(workspace, 'ROLLBACK_BLOCKED', 'ECP_1', 'PrjLibrary.mdb')), true);
      assert.equal(await exists(project.dir), true);
      assert.equal((await stat(project.dir)).isFile(), true, '旧路径应保持临时阻塞文件，不应被写成目录');
    });
  });

  test('B3：map.add / map.update 后删除目标变量会被阻止，不产生新悬空映射', async () => {
    for (const operation of ['map.add', 'map.update'] as const) {
      await withProject(operation.replace('.', '-'), async (project, snapshot) => {
        const added = await saveProject({
          snapshot,
          bridge,
          draft: { ops: [{ kind: 'variable.add', tempId: 'v', input: variableInput({ name: 'UNUSED', userAddress: '' }) }] },
        });
        const unused = added.snapshot.db?.variables.find((item) => item.name === 'UNUSED');
        assert.ok(unused);
        const mapping =
          operation === 'map.add'
            ? {
                kind: 'map.add' as const,
                tempId: 'm',
                input: { deviceRef: { kind: 'existing' as const, id: 1000 }, symbolRef: { kind: 'existing' as const, id: unused.id }, address: '400010', access: 1 },
              }
            : {
                kind: 'map.update' as const,
                id: 1,
                input: { deviceRef: { kind: 'existing' as const, id: 1000 }, symbolRef: { kind: 'existing' as const, id: unused.id }, address: '400010', access: 1 },
              };
        const draft: Draft = { ops: [mapping, { kind: 'variable.delete', id: unused.id }] };
        const plan = buildPlan({ snapshot: added.snapshot, draft });
        assert.equal(plan.canSave, false);
        assert.match(plan.diagnostics.map((item) => item.message).join('\n'), /通讯映射/);
        await assert.rejects(saveProject({ snapshot: added.snapshot, draft, bridge }), /通讯映射/);
        const after = await bridge.snapshot(project.dbPath);
        assert.equal(after.variables.some((item) => item.id === unused.id), true);
      });
    }
  });

  test('B3：保存前已有的悬空映射保留，并给出准确警告', async () => {
    await withProject('baseline-orphan', async (project, snapshot) => {
      await bridge.apply(project.dbPath, [
        {
          op: 'map.insert',
          tempId: 'orphan',
          row: {
            id: 99,
            deviceRef: { kind: 'existing', id: 1000 },
            symbolRef: { kind: 'existing', id: 9999 },
            address: '499999',
            access: 1,
          },
        },
      ]);
      const reopened = await openProject(project.entryPath, bridge);
      const result = await saveProject({
        snapshot: reopened,
        bridge,
        draft: { ops: [{ kind: 'variable.add', tempId: 'v', input: variableInput({ name: 'KEEP_ME', userAddress: '' }) }] },
      });
      assert.equal(result.snapshot.db?.maps.some((map) => map.id === 99 && map.symbolId === 9999), true);
      assert.match(result.warnings.join('\n'), /保存前已存在/);
      assert.equal(result.snapshot.db?.variables.some((item) => item.name === 'KEEP_ME'), true);
    });
  });

  test('未注册的同名 .stf 不会被新增或改名覆盖', async () => {
    await withProject('unregistered', async (project, snapshot) => {
      const resourceDir = path.dirname(project.stPath);
      const extra = path.join(resourceDir, 'EXTRA.stf');
      await writeFile(extra, encodeGbk('PROGRAM EXTRA\r\nEND_PROGRAM\r\n'));
      const extraBefore = await hash(extra);
      const addPlan = buildPlan({
        snapshot,
        draft: { ops: [{ kind: 'program.add', tempId: 'p', input: programInput('EXTRA') }] },
      });
      assert.equal(addPlan.canSave, false);
      assert.match(addPlan.diagnostics.map((item) => item.message).join('\n'), /目标源文件已存在/);
      const renamePlan = buildPlan({
        snapshot,
        draft: { ops: [{ kind: 'program.update', id: 1, input: programInput('EXTRA') }] },
      });
      assert.equal(renamePlan.canSave, false);
      assert.equal(await hash(extra), extraBefore);
    });
  });

  test('新增程序后再变量改名，未注册同名 .stf 仍不会被覆盖', async () => {
    await withProject('overwrite-orphan', async (project, snapshot) => {
      const resourceDir = path.dirname(project.stPath);
      const extra = path.join(resourceDir, 'EXTRA.stf');
      await writeFile(extra, encodeGbk('(* ORIGINAL UNREGISTERED FILE *)\r\nPROGRAM EXTRA\r\nEND_PROGRAM\r\n'));
      const extraBefore = await hash(extra);
      const add = {
        kind: 'program.add' as const,
        tempId: 'p',
        input: { name: 'EXTRA', comment: '', languageId: 1, resourceId: 1, sourceText: 'PROGRAM EXTRA\r\nHB01 := 1;\r\nEND_PROGRAM\r\n' },
      };
      const renameOp = { kind: 'variable.update' as const, id: 2, input: variableInput({ name: 'RENAMED' }) };
      for (const ops of [[add, renameOp], [renameOp, add]]) {
        const plan = buildPlan({ snapshot, draft: { ops } });
        assert.equal(plan.canSave, false);
        assert.match(plan.diagnostics.map((item) => item.message).join('\n'), /目标源文件已存在/);
        await assert.rejects(saveProject({ snapshot, bridge, draft: { ops } }), /目标源文件已存在/);
        assert.equal(await hash(extra), extraBefore);
      }
    });
  });

  test('注释位于文件开头时程序改名只保留一个 PROGRAM 头', async () => {
    await withProject('comment-header', async (project, snapshot) => {
      const withComment = `(* 文件头注释 *)\r\n${ST_SOURCE}`;
      await writeFile(project.stPath, encodeGbk(withComment));
      const reopened = await openProject(project.entryPath, bridge);
      const saved = await saveProject({
        snapshot: reopened,
        bridge,
        draft: { ops: [{ kind: 'program.update', id: 1, input: programInput('COMMENTED') }] },
      });
      const newPath = path.join(path.dirname(project.stPath), 'COMMENTED.stf');
      const text = await stText(newPath);
      assert.equal(text.startsWith('(* 文件头注释 *)\r\n'), true);
      assert.equal(programHeaderName(text), 'COMMENTED');
      assert.equal((text.match(/\bPROGRAM\b/g) ?? []).length, 1);
      assert.equal(saved.snapshot.diagnostics.some((item) => item.code === 'program.headerMismatch'), false);
    });
  });

  test('junction 把 DataDir 指到工程外时拒绝保存且不写外部文件', async () => {
    const workspace = await createWorkspace();
    try {
      const project = await createSyntheticProject(workspace, 'JUNCTION');
      const outside = path.join(workspace, 'outside-project');
      await rename(path.join(project.dir, 'ECP_1'), outside);
      await symlink(outside, path.join(project.dir, 'ECP_1'), 'junction');
      const snapshot = await openProject(project.entryPath, bridge);
      assert.equal(snapshot.pathSafety?.writable, false);
      assert.equal(snapshot.diagnostics.some((item) => item.code === 'path.outsideProject'), true);
      const draft: Draft = {
        ops: [
          { kind: 'program.add', tempId: 'p', input: programInput('BOUNDARY') },
          { kind: 'variable.update', id: 2, input: variableInput({ name: 'RENAMED' }) },
        ],
      };
      const plan = buildPlan({ snapshot, draft });
      assert.equal(plan.canSave, false);
      await assert.rejects(saveProject({ snapshot, bridge, draft }), /越出工程根目录|物理位置/);
      assert.equal(await exists(path.join(outside, 'Config1', 'Resource1', 'BOUNDARY.stf')), false);
    } finally {
      await cleanup(workspace);
    }
  });

  test('打开后把 DataDir 换成 junction，保存前仍会重新校验物理路径', async () => {
    const workspace = await createWorkspace();
    try {
      const project = await createSyntheticProject(workspace, 'JUNCTION_SWAP');
      const snapshot = await openProject(project.entryPath, bridge);
      assert.equal(snapshot.pathSafety?.writable, true);
      const outside = path.join(workspace, 'outside-project');
      await rename(path.join(project.dir, 'ECP_1'), outside);
      await symlink(outside, path.join(project.dir, 'ECP_1'), 'junction');
      const draft: Draft = { ops: [{ kind: 'program.add', tempId: 'p', input: programInput('BOUNDARY') }] };
      await assert.rejects(saveProject({ snapshot, bridge, draft }), /越出工程根目录|物理位置/);
      assert.equal(await exists(path.join(outside, 'Config1', 'Resource1', 'BOUNDARY.stf')), false);
    } finally {
      await cleanup(workspace);
    }
  });

  test('DataDir 含路径分隔符或越界时打开即标记不安全', async () => {
    const workspace = await createWorkspace();
    try {
      const project = await createSyntheticProject(workspace, 'BAD_DIR');
      const xml = await readFile(project.entryPath, 'utf8');
      await writeFile(project.entryPath, xml.replace('<DataDir>ECP_1</DataDir>', '<DataDir>..\\outside</DataDir>'), 'utf8');
      const snapshot = await openProject(project.entryPath, bridge);
      assert.equal(snapshot.pathSafety?.writable, false);
      assert.equal(snapshot.diagnostics.some((item) => item.code === 'device.dataDirInvalid'), true);
    } finally {
      await cleanup(workspace);
    }
  });

  test('多设备工程用数据库所在设备的资源目录写程序', async () => {
    const workspace = await createWorkspace();
    try {
      const project = await createSyntheticProject(workspace, 'MULTI');
      await mkdir(path.join(project.dir, 'NO_DB', 'Config1', 'Resource1'), { recursive: true });
      const multiMgp = `<?xml version='1.0' encoding='utf-8'?>\r\n<Project Name="MULTI"><Version>4</Version><IDEVersion>V1.03.00.006</IDEVersion><Description>multi</Description><Buses /><Devices><Device Name="A" ID="1"><ConfigurationData><DataDir>NO_DB</DataDir></ConfigurationData></Device><Device Name="ECP" ID="2"><ConfigurationData><DataDir>ECP_1</DataDir></ConfigurationData></Device></Devices><RootDevices /></Project>`;
      await writeFile(project.entryPath, multiMgp, 'utf8');
      const snapshot = await openProject(project.entryPath, bridge);
      assert.equal(path.basename(path.dirname(snapshot.dbPath ?? '')), 'ECP_1');
      const plan = buildPlan({
        snapshot,
        draft: { ops: [{ kind: 'program.add', tempId: 'p', input: programInput('NEWP') }] },
      });
      assert.equal(plan.canSave, true, plan.diagnostics.map((item) => item.message).join('\n'));
      assert.equal(plan.programWrites[0]?.path.toLowerCase().includes(path.join('ecp_1', 'config1', 'resource1').toLowerCase()), true);
    } finally {
      await cleanup(workspace);
    }
  });

  test('非 ST 程序不会被变量改名重写，且不能删除', async () => {
    const workspace = await createWorkspace();
    try {
      const dir = path.join(workspace, 'NONST');
      const dataDir = path.join(dir, 'ECP_1');
      const resourceDir = path.join(dataDir, 'Config1', 'Resource1');
      await mkdir(resourceDir, { recursive: true });
      const entryPath = path.join(dir, 'NONST.mgp');
      await writeFile(entryPath, MGP_XML.replace('Name="DEMO"', 'Name="NONST"'), 'utf8');
      const rows = sampleRows();
      rows.Languages = [{ Name: 'ST' }, { Name: 'LD' }];
      rows.POUs?.push({
        Name: 'LDMAIN',
        SingleTextLine: null,
        Comment: null,
        RefLanguage: 2,
        RefResource: 1,
        Order: 2,
        RefPOUtype: 1,
        ReadOnly: false,
        GenerateSymbMon: true,
        Encrypted: false,
      });
      rows.Programs?.push({ RefPOUs: 3, Order: 2, RefFather: 0 });
      await createFixtureDatabase(dataDir, rows);
      await writeFile(path.join(resourceDir, 'MAIN.stf'), encodeGbk(ST_SOURCE));
      const ldPath = path.join(resourceDir, 'LDMAIN.stf');
      await writeFile(ldPath, encodeGbk('PROGRAM LDMAIN\r\nHB01 := 1;\r\nEND_PROGRAM\r\n'));
      const ldBefore = await hash(ldPath);
      const snapshot = await openProject(entryPath, bridge);
      const ldProgram = snapshot.db?.programs.find((item) => item.name === 'LDMAIN');
      assert.ok(ldProgram);
      assert.equal(isAllowedStSourcePath(snapshot, ldPath), true, '非 ST 源文件仍可只读打开');
      assert.equal(isWritableStSourcePath(snapshot, ldPath), false, '非 ST 源文件禁止写回');
      assert.equal(isWritableStSourcePath(snapshot, path.join(resourceDir, 'MAIN.stf')), true);
      const renamePlan = buildPlan({
        snapshot,
        draft: { ops: [{ kind: 'variable.update', id: 2, input: variableInput({ name: 'RENAMED' }) }] },
      });
      assert.equal(renamePlan.canSave, false);
      assert.match(renamePlan.diagnostics.map((item) => item.message).join('\n'), /非 ST 程序 LDMAIN/);
      const deletePlan = buildPlan({ snapshot, draft: { ops: [{ kind: 'program.delete', id: ldProgram.id }] } });
      assert.equal(deletePlan.canSave, false);
      assert.match(deletePlan.diagnostics.map((item) => item.message).join('\n'), /不是 ST 语言/);
      assert.equal(await hash(ldPath), ldBefore);
    } finally {
      await cleanup(workspace);
    }
  });

  test('没有既有通道的端口会被阻止新增，避免 KLP 不显示', async () => {
    await withProject('port-boundary', async (_project, snapshot) => {
      const plan = buildPlan({
        snapshot,
        draft: { ops: [{ kind: 'channel.add', tempId: 'c', input: { ...channelInput, name: 'CH_PORT5', portNum: 5 } }] },
      });
      assert.equal(plan.canSave, false);
      assert.match(plan.diagnostics.map((item) => item.message).join('\n'), /KLP 可能不显示新建通道/);
    });
  });

  test('设备改指新通道后可以删除旧通道，之后删除新通道会被阻止', async () => {
    await withProject('channel-move', async (project, snapshot) => {
      const first = await saveProject({
        snapshot,
        bridge,
        draft: {
          ops: [
            { kind: 'channel.add', tempId: 'c2', input: channelInput },
            { kind: 'device.update', id: 1000, input: deviceInput({ kind: 'new', tempId: 'c2' }) },
            { kind: 'channel.delete', id: 1 },
          ],
        },
      });
      assert.equal(first.snapshot.db?.channels.some((item) => item.id === 1), false);
      const device = first.snapshot.db?.devices.find((item) => item.id === 1000);
      const newChannel = first.snapshot.db?.channels.find((item) => item.name === 'COM1CH2');
      assert.ok(device && newChannel);
      assert.equal(device.channelId, newChannel.id);
      const second = buildPlan({
        snapshot: first.snapshot,
        draft: { ops: [{ kind: 'channel.delete', id: newChannel.id }] },
      });
      assert.equal(second.canSave, false);
      assert.match(second.diagnostics.map((item) => item.message).join('\n'), /被设备 SLAVE1 引用/);
    });
  });

  test('同一草稿新增变量和程序同名时双向阻止', async () => {
    await withProject('pending-collision', async (_project, snapshot) => {
      const program = { kind: 'program.add' as const, tempId: 'p', input: programInput('COLLIDE') };
      const variable = { kind: 'variable.add' as const, tempId: 'v', input: variableInput({ name: 'COLLIDE', userAddress: '' }) };
      for (const ops of [[program, variable], [variable, program]]) {
        const plan = buildPlan({ snapshot, draft: { ops } });
        assert.equal(plan.canSave, false);
        assert.match(plan.diagnostics.map((item) => item.message).join('\n'), /不能同名/);
      }
    });
  });

  test('同一草稿先删除程序后新增同名变量应允许', async () => {
    await withProject('delete-then-add-name', async (_project, snapshot) => {
      const plan = buildPlan({
        snapshot,
        draft: {
          ops: [
            { kind: 'program.delete', id: 1 },
            { kind: 'variable.add', tempId: 'v', input: variableInput({ name: 'MAIN', userAddress: '' }) },
          ],
        },
      });
      assert.equal(plan.canSave, true, plan.diagnostics.map((item) => item.message).join('\n'));
    });
  });

  test('先删除程序再新增同名程序应允许并复用目标文件', async () => {
    await withProject('program-name-reuse', async (project, snapshot) => {
      const first = await saveProject({
        snapshot,
        bridge,
        draft: { ops: [{ kind: 'program.add', tempId: 'sub', input: programInput('SUB') }] },
      });
      const draft: Draft = {
        ops: [
          { kind: 'program.delete', id: 1 },
          { kind: 'program.add', tempId: 'main2', input: { ...programInput('MAIN'), sourceText: 'PROGRAM MAIN\r\nEND_PROGRAM\r\n' } },
        ],
      };
      const plan = buildPlan({ snapshot: first.snapshot, draft });
      assert.equal(plan.canSave, true, plan.diagnostics.map((item) => item.message).join('\n'));
      const saved = await saveProject({ snapshot: first.snapshot, bridge, draft });
      assert.equal(saved.snapshot.db?.programs.some((item) => item.name === 'MAIN'), true);
      assert.equal(saved.snapshot.db?.programs.some((item) => item.name === 'SUB'), true);
      assert.equal(await stText(project.stPath).then((text) => text.startsWith('PROGRAM MAIN')), true);
    });
  });

  test('ST 源文件缺失或解码有损时阻止变量改名/删除', async () => {
    await withProject('missing-source', async (project, snapshot) => {
      await rename(project.stPath, `${project.stPath}.missing`);
      const reopened = await openProject(project.entryPath, bridge);
      const renamePlan = buildPlan({
        snapshot: reopened,
        draft: { ops: [{ kind: 'variable.update', id: 2, input: variableInput({ name: 'RENAMED' }) }] },
      });
      assert.equal(renamePlan.canSave, false);
      assert.match(renamePlan.diagnostics.map((item) => item.message).join('\n'), /源文件缺失或含无法解码字节/);
      const deletePlan = buildPlan({ snapshot: reopened, draft: { ops: [{ kind: 'variable.delete', id: 2 }] } });
      assert.equal(deletePlan.canSave, false);
      assert.match(deletePlan.diagnostics.map((item) => item.message).join('\n'), /源文件缺失或含无法解码字节/);
    });
    await withProject('lossy-source', async (project, snapshot) => {
      void snapshot;
      await writeFile(project.stPath, Uint8Array.from([0x81, 0x20, 0x0d, 0x0a]));
      const reopened = await openProject(project.entryPath, bridge);
      assert.equal(reopened.devices[0]?.programs[0]?.lossy, true);
      assert.doesNotThrow(() => stBytesForEditor(Uint8Array.from([0x81, 0x20])));
      const renamePlan = buildPlan({
        snapshot: reopened,
        draft: { ops: [{ kind: 'variable.update', id: 2, input: variableInput({ name: 'RENAMED' }) }] },
      });
      assert.equal(renamePlan.canSave, false);
    });
  });

  test('Programs 表缺行时拒绝更新/删除程序', async () => {
    const workspace = await createWorkspace();
    try {
      const dir = path.join(workspace, 'NO_PROGRAM_ROW');
      const dataDir = path.join(dir, 'ECP_1');
      const resourceDir = path.join(dataDir, 'Config1', 'Resource1');
      await mkdir(resourceDir, { recursive: true });
      const entryPath = path.join(dir, 'NO_PROGRAM_ROW.mgp');
      await writeFile(entryPath, MGP_XML.replace('Name="DEMO"', 'Name="NO_PROGRAM_ROW"'), 'utf8');
      const rows = sampleRows();
      rows.Programs = [];
      await createFixtureDatabase(dataDir, rows);
      await writeFile(path.join(resourceDir, 'MAIN.stf'), encodeGbk(ST_SOURCE));
      const snapshot = await openProject(entryPath, bridge);
      assert.equal(snapshot.db?.programs[0]?.hasProgramRow, false);
      const update = buildPlan({
        snapshot,
        draft: { ops: [{ kind: 'program.update', id: 1, input: programInput('MAIN2') }] },
      });
      assert.equal(update.canSave, false);
      assert.match(update.diagnostics.map((item) => item.message).join('\n'), /Programs 表中缺少注册行/);
      const remove = buildPlan({ snapshot, draft: { ops: [{ kind: 'program.delete', id: 1 }] } });
      assert.equal(remove.canSave, false);
      assert.match(remove.diagnostics.map((item) => item.message).join('\n'), /Programs 表中缺少注册行/);
    } finally {
      await cleanup(workspace);
    }
  });

  test('保存前已悬空的设备通道不会永久阻止其他草稿', async () => {
    const workspace = await createWorkspace();
    try {
      const dir = path.join(workspace, 'DANGLING_DEVICE');
      const dataDir = path.join(dir, 'ECP_1');
      const resourceDir = path.join(dataDir, 'Config1', 'Resource1');
      await mkdir(resourceDir, { recursive: true });
      const entryPath = path.join(dir, 'DANGLING_DEVICE.mgp');
      await writeFile(entryPath, MGP_XML.replace('Name="DEMO"', 'Name="DANGLING_DEVICE"'), 'utf8');
      const rows = sampleRows();
      rows.GWDevice = [{ ...rows.GWDevice?.[0], RefChannel: 999 }];
      await createFixtureDatabase(dataDir, rows);
      await writeFile(path.join(resourceDir, 'MAIN.stf'), encodeGbk(ST_SOURCE));
      const snapshot = await openProject(entryPath, bridge);
      assert.equal(snapshot.diagnostics.some((item) => item.code === 'device.channelOrphan'), true);
      const plan = buildPlan({
        snapshot,
        draft: { ops: [{ kind: 'variable.add', tempId: 'v', input: variableInput({ name: 'DANGLING_OK', userAddress: '' }) }] },
      });
      assert.equal(plan.canSave, true, plan.diagnostics.map((item) => item.message).join('\n'));
    } finally {
      await cleanup(workspace);
    }
  });

  test('变量更新保留 RefStatus 的 NULL，不写成空字符串', async () => {
    await withProject('status-null', async (project, snapshot) => {
      assert.equal(snapshot.db?.variables.find((item) => item.id === 2)?.status, null);
      const saved = await saveProject({
        snapshot,
        bridge,
        draft: { ops: [{ kind: 'variable.update', id: 2, input: variableInput({ name: 'HB01', comment: '只改注释' }) }] },
      });
      assert.equal(saved.snapshot.db?.variables.find((item) => item.id === 2)?.status, null);
      assert.equal((await bridge.snapshot(project.dbPath)).variables.find((item) => item.id === 2)?.status, null);
    });
  });

  test('变量与程序/功能块跨命名空间碰撞会被阻止', async () => {
    await withProject('name-collision', async (_project, snapshot) => {
      const variablePlan = buildPlan({
        snapshot,
        draft: { ops: [{ kind: 'variable.update', id: 2, input: variableInput({ name: 'MAIN' }) }] },
      });
      assert.equal(variablePlan.canSave, false);
      assert.match(variablePlan.diagnostics.map((item) => item.message).join('\n'), /变量与 POU 不能同名/);
      const programPlan = buildPlan({
        snapshot,
        draft: { ops: [{ kind: 'program.update', id: 1, input: programInput('HB01') }] },
      });
      assert.equal(programPlan.canSave, false);
      assert.match(programPlan.diagnostics.map((item) => item.message).join('\n'), /程序与变量不能同名/);
      const pendingPlan = buildPlan({
        snapshot,
        draft: {
          ops: [
            { kind: 'variable.add', tempId: 'v', input: variableInput({ name: 'PENDING_VAR', userAddress: '' }) },
            { kind: 'variable.update', id: -1, input: variableInput({ name: 'PENDING_VAR2', userAddress: '' }) },
          ],
        },
      });
      assert.equal(pendingPlan.canSave, false);
      assert.match(pendingPlan.diagnostics.map((item) => item.message).join('\n'), /尚未保存/);
      const caseVariable = buildPlan({
        snapshot,
        draft: { ops: [{ kind: 'variable.update', id: 2, input: variableInput({ name: 'hb01' }) }] },
      });
      assert.equal(caseVariable.canSave, false);
      assert.match(caseVariable.diagnostics.map((item) => item.message).join('\n'), /仅改变大小写/);
      const caseProgram = buildPlan({
        snapshot,
        draft: { ops: [{ kind: 'program.update', id: 1, input: programInput('main') }] },
      });
      assert.equal(caseProgram.canSave, false);
      assert.match(caseProgram.diagnostics.map((item) => item.message).join('\n'), /仅改变大小写/);
    });
  });

  test('同一事务多次插入变量和程序时获得互不冲突的主键', async () => {
    const workspace = await createWorkspace();
    try {
      const dir = path.join(workspace, 'IDS');
      await mkdir(dir);
      const dbPath = await createFixtureDatabase(dir, sampleRows());
      const result = await bridge.apply(dbPath, [
        {
          op: 'variable.insert',
          tempId: 'v1',
          row: {
            name: 'V1', comment: '', alias: '', varInstanceId: 1, resourcePouId: 1, scopeId: 1, defTypeId: 2,
            stringSize: 0, attributeId: 2, directionId: 2, groupId: 2, userAddress: '', wiring: '', isRetain: false,
            order: 30, hasDimension: false, initialValue: '', refLibrary: null, hook: null, crcInitValueDim: 1,
            crcInitValueType: 164937643, status: '',
          },
        },
        {
          op: 'variable.insert',
          tempId: 'v2',
          row: {
            name: 'V2', comment: '', alias: '', varInstanceId: 1, resourcePouId: 1, scopeId: 1, defTypeId: 2,
            stringSize: 0, attributeId: 2, directionId: 2, groupId: 2, userAddress: '', wiring: '', isRetain: false,
            order: 31, hasDimension: false, initialValue: '', refLibrary: null, hook: null, crcInitValueDim: 1,
            crcInitValueType: 164937643, status: '',
          },
        },
        {
          op: 'program.insert',
          tempId: 'p1',
          row: { name: 'P1', comment: '', languageId: 1, resourceId: 1, order: 2, readOnly: false, generateSymbMon: true, refLocalization: 0, refPouGroup: 0, generateDebugInfo: false, is1499: false },
        },
        {
          op: 'program.insert',
          tempId: 'p2',
          row: { name: 'P2', comment: '', languageId: 1, resourceId: 1, order: 3, readOnly: false, generateSymbMon: true, refLocalization: 0, refPouGroup: 0, generateDebugInfo: false, is1499: false },
        },
      ]);
      assert.notEqual(result.ids['v1'], result.ids['v2']);
      assert.notEqual(result.ids['p1'], result.ids['p2']);
      assert.equal(result.snapshot.variables.filter((item) => item.name.startsWith('V')).length, 2);
      assert.equal(result.snapshot.programs.filter((item) => item.name === 'P1' || item.name === 'P2').length, 2);
    } finally {
      await cleanup(workspace);
    }
  });

  test('同一草稿新增两个通道、设备和映射时主键互不冲突', async () => {
    await withProject('multi-comm', async (_project, snapshot) => {
      const saved = await saveProject({
        snapshot,
        bridge,
        draft: {
          ops: [
            { kind: 'channel.add', tempId: 'c1', input: { ...channelInput, name: 'CH_A' } },
            { kind: 'channel.add', tempId: 'c2', input: { ...channelInput, name: 'CH_B', portNum: 1 } },
            { kind: 'device.add', tempId: 'd1', input: { ...deviceInput({ kind: 'new', tempId: 'c1' }), name: 'DEV_A' } },
            { kind: 'device.add', tempId: 'd2', input: { ...deviceInput({ kind: 'new', tempId: 'c2' }), name: 'DEV_B', modbus: { ...deviceInput({ kind: 'existing', id: 1 }).modbus, station: 2 } } },
            { kind: 'map.add', tempId: 'm1', input: { deviceRef: { kind: 'new', tempId: 'd1' }, symbolRef: { kind: 'existing', id: 2 }, address: '401001', access: 1 } },
            { kind: 'map.add', tempId: 'm2', input: { deviceRef: { kind: 'new', tempId: 'd2' }, symbolRef: { kind: 'existing', id: 2 }, address: '401002', access: 1 } },
          ],
        },
      });
      const channels = saved.snapshot.db?.channels.filter((item) => item.name.startsWith('CH_')) ?? [];
      const devices = saved.snapshot.db?.devices.filter((item) => item.name.startsWith('DEV_')) ?? [];
      const maps = saved.snapshot.db?.maps.filter((item) => item.address.startsWith('4010')) ?? [];
      assert.equal(channels.length, 2);
      assert.equal(new Set(channels.map((item) => item.id)).size, 2);
      assert.equal(devices.length, 2);
      assert.equal(new Set(devices.map((item) => item.id)).size, 2);
      assert.equal(maps.length, 2);
      assert.equal(new Set(maps.map((item) => item.id)).size, 2);
      assert.equal(devices.find((item) => item.name === 'DEV_A')?.channelId, channels.find((item) => item.name === 'CH_A')?.id);
      assert.equal(devices.find((item) => item.name === 'DEV_B')?.channelId, channels.find((item) => item.name === 'CH_B')?.id);
    });
  });

  test('klp-st 白名单只允许已注册 ST 源文件', async () => {
    await withProject('whitelist', async (project, snapshot, workspace) => {
      assert.equal(isAllowedStSourcePath(snapshot, project.stPath), true);
      assert.equal(isAllowedStSourcePath(snapshot, path.join(path.dirname(project.stPath), 'EXTRA.stf')), false);
      assert.equal(isAllowedStSourcePath(snapshot, path.join(workspace, 'outside.stf')), false);
      assert.equal(isAllowedStSourcePath(snapshot, 'C:\\Windows\\System32\\drivers\\etc\\hosts'), false);
    });
  });

  test('UTF-8 BOM 的 ST 文件在变量改名后保留 BOM 与编码', async () => {
    await withProject('bom', async (project, snapshot) => {
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      await writeFile(project.stPath, Buffer.concat([bom, Buffer.from(ST_SOURCE, 'utf8')]));
      const reopened = await openProject(project.entryPath, bridge);
      const source = reopened.devices[0]?.programs[0];
      assert.equal(source?.encoding, 'utf-8');
      assert.equal(source?.bom, true);
      const saved = await saveProject({
        snapshot: reopened,
        bridge,
        draft: { ops: [{ kind: 'variable.update', id: 2, input: variableInput({ name: 'BOM_RENAMED' }) }] },
      });
      const bytes = await readFile(project.stPath);
      assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      const decoded = decodeStBytes(bytes);
      assert.equal(decoded.encoding, 'utf-8');
      assert.equal(/\bBOM_RENAMED\b/.test(decoded.text), true);
      assert.equal(saved.snapshot.devices[0]?.programs[0]?.bom, true);
    });
  });

  test('提交成功但重新读取失败时返回已保存警告，而不是抛保存失败', async () => {
    await withProject('refresh-fail', async (project, snapshot) => {
      const broken = `${project.entryPath}.broken`;
      const result = await saveProject({
        snapshot,
        bridge,
        hooks: {
          afterCommit: async () => {
            await rename(project.entryPath, broken);
          },
        },
        draft: { ops: [{ kind: 'variable.add', tempId: 'v', input: variableInput({ name: 'SAVED_BUT_RELOAD_FAILED', userAddress: '' }) }] },
      });
      assert.equal(result.refreshError !== undefined, true);
      assert.match(result.warnings.join('\n'), /保存已提交/);
      assert.equal(result.snapshot.diagnostics.some((item) => item.code === 'project.reloadFailed'), true);
      const actual = await bridge.snapshot(project.dbPath);
      assert.equal(actual.variables.some((item) => item.name === 'SAVED_BUT_RELOAD_FAILED'), true);
      await rename(broken, project.entryPath);
    });
  });
});


