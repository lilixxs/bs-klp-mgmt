import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeSt,
  collectIdentifiers,
  findAssignmentTargets,
  hasEndProgram,
  programHeader,
  ST_BUILTINS,
  ST_KEYWORDS,
  wordAt,
} from '../src/st/analysis.ts';
import { buildStContext, variableMarkdown } from '../src/st/index.ts';
import type { ProjectSnapshot } from '../src/shared/types.ts';

function context(blockName = 'MAIN') {
  const snapshot = {
    db: {
      variables: [
        { id: 1, name: 'HB01', comment: '心跳位', groupId: 2, defTypeId: 2, varInstanceId: 1, userAddress: '9c41', wiring: '', initialValue: '', isRetain: false },
        { id: 2, name: 'BLINK2', comment: '', groupId: 2, defTypeId: 3, varInstanceId: 2, userAddress: '', wiring: '', initialValue: '', isRetain: false },
      ],
      groups: [{ id: 2, name: 'MOD1' }],
      definitionTypes: [
        { id: 2, name: 'INT' },
        { id: 3, name: 'BLINK' },
      ],
      pous: [
        { id: 3, name: 'BLINK', typeId: 3 },
        { id: 9, name: 'MAIN', typeId: 1 },
      ],
      programs: [{ id: 9, name: 'MAIN' }],
    },
  } as unknown as ProjectSnapshot;
  return buildStContext(snapshot, blockName);
}

const source = ['PROGRAM MAIN', 'HB01 := HB01 + 1;', 'NOT_DECLARED := 2;', 'END_PROGRAM', ''].join('\r\n');

test('结构检查：头、结尾与块注释', () => {
  const ctx = context();
  assert.equal(programHeader(source)?.name, 'MAIN');
  assert.equal(hasEndProgram(source), true);
  assert.equal(analyzeSt(source, ctx).filter((item) => item.severity === 'error').length, 0);
  const broken = 'PROGRAM MAIN\r\n(* 未闭合\r\nEND_PROGRAM\r\n';
  const diagnostics = analyzeSt(broken, ctx);
  assert.equal(diagnostics.some((item) => item.code === 'st.commentUnterminated'), true);
});

test('PROGRAM 头与注册名不一致会报错', () => {
  const diagnostics = analyzeSt(source, context('OTHER'));
  assert.equal(diagnostics.some((item) => item.code === 'st.programHeaderMismatch'), true);
});

test('未知赋值目标给警告，已知变量与关键字不报', () => {
  const diagnostics = analyzeSt(source, context());
  const unknown = diagnostics.filter((item) => item.code === 'st.unknownAssignmentTarget');
  assert.equal(unknown.length, 1);
  assert.equal(source.slice(unknown[0]?.start, unknown[0]?.end), 'NOT_DECLARED');
});

test('注释与字符串中的赋值不计入', () => {
  const text = ["PROGRAM MAIN", '(* X := 1 *)', "S := 'Y := 2';", 'HB01 := 3;', 'END_PROGRAM'].join('\r\n');
  const targets = findAssignmentTargets(text).map((item) => item.name);
  assert.deepEqual(targets, ['S', 'HB01']);
});

test('wordAt 与标识符收集', () => {
  const at = wordAt(source, source.indexOf('HB01') + 2);
  assert.deepEqual(at && { word: at.word }, { word: 'HB01' });
  const words = collectIdentifiers(source);
  assert.equal(words.includes('HB01'), true);
  assert.equal(words.includes('NOT_DECLARED'), true);
});

test('符号索引与悬停文档', () => {
  const ctx = context();
  assert.equal(ctx.variables.get('hb01')?.typeName, 'INT');
  assert.equal(ctx.variables.get('hb01')?.groupName, 'MOD1');
  assert.equal(ctx.variables.get('blink2')?.isInstance, true);
  assert.equal(ctx.functionBlocks.has('BLINK'), true);
  const markdown = variableMarkdown(ctx.variables.get('hb01')!);
  assert.match(markdown, /心跳位/);
  assert.match(markdown, /MOD1/);
});

test('关键字与标准函数表非空且无重复', () => {
  assert.equal(new Set(ST_KEYWORDS).size, ST_KEYWORDS.length);
  assert.equal(new Set(ST_BUILTINS).size, ST_BUILTINS.length);
  assert.equal(ST_BUILTINS.includes('ANY_TO_INT'), true);
});
