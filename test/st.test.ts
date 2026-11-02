import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultProgramTemplate,
  findIdentifierUsages,
  programHeaderName,
  renameProgramHeader,
  replaceIdentifier,
  splitCodeSegments,
} from '../src/project/st.ts';

const source = [
  'PROGRAM MAIN',
  '// HB01 在行注释里',
  '(* HB01 在块注释里 *)',
  "msg := 'HB01 在字符串里';",
  'HB01 := HB01 + 1;',
  'END_PROGRAM',
  '',
].join('\r\n');

test('注释和字符串不计为标识符引用', () => {
  const usages = findIdentifierUsages(source, 'HB01', 'MAIN');
  assert.equal(usages.length, 2);
  assert.deepEqual(
    usages.map((usage) => usage.line),
    [5, 5],
  );
});

test('替换只改代码中的标识符', () => {
  const result = replaceIdentifier(source, 'hb01', 'COUNT01');
  assert.equal(result.count, 2);
  assert.equal(result.text.includes('// HB01 在行注释里'), true);
  assert.equal(result.text.includes("'HB01 在字符串里'"), true);
  assert.equal(result.text.includes('COUNT01 := COUNT01 + 1;'), true);
});

test('代码段划分覆盖注释与字符串', () => {
  const segments = splitCodeSegments(source);
  const code = segments.filter((segment) => segment.code).map((segment) => source.slice(segment.start, segment.end)).join('');
  assert.equal(code.includes('//'), false);
  assert.equal(code.includes("'"), false);
  assert.equal(code.includes('HB01 := HB01 + 1;'), true);
});

test('嵌套块注释内的标识符不参与替换', () => {
  const text = ['PROGRAM MAIN', '(* outer (* inner HB01 *) still comment *)', 'HB01 := 1;', 'END_PROGRAM'].join('\r\n');
  const result = replaceIdentifier(text, 'HB01', 'RENAMED');
  assert.equal(result.count, 1);
  assert.equal(result.text.includes('inner HB01'), true);
  assert.equal(result.text.includes('RENAMED := 1;'), true);
});

test('PROGRAM 头改名', () => {
  const renamed = renameProgramHeader(source, 'MAIN', 'SUB');
  assert.equal(programHeaderName(renamed), 'SUB');
  assert.equal(renamed.split('\r\n')[0], 'PROGRAM SUB');
  assert.equal(renameProgramHeader('X := 1;', 'MAIN', 'SUB'), '');
});

test('新程序模板包含头与结束标记', () => {
  const template = defaultProgramTemplate('SUB');
  assert.equal(template, 'PROGRAM SUB\r\n\r\nEND_PROGRAM\r\n');
});
