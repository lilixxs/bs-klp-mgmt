import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  findProjectNameAttribute,
  parseMgp,
  readProjectNameFromMgp,
  renameProjectInMgp,
} from '../src/project/mgpParser.ts';

const xml = readFileSync(new URL('./fixtures/sample.mgp', import.meta.url), 'utf8');

test('读取工程名、版本与设备', () => {
  const project = parseMgp(xml);
  assert.equal(project.name, 'demo');
  assert.equal(project.version, '4');
  assert.equal(project.devices[0]?.dataDir, 'ECP_1');
  assert.equal(project.devices[0]?.refFamily, '6');
});

test('改名只改 <Project> 的 Name 属性', () => {
  const renamed = renameProjectInMgp(xml, 'renamed-demo');
  assert.equal(readProjectNameFromMgp(renamed), 'renamed-demo');
  const location = findProjectNameAttribute(xml);
  const renamedLocation = findProjectNameAttribute(renamed);
  assert.ok(location && renamedLocation);
  const prefix = xml.slice(0, location.start);
  const suffix = xml.slice(location.end);
  assert.equal(renamed.slice(0, renamedLocation.start), prefix);
  assert.equal(renamed.slice(renamedLocation.end), suffix);
  assert.equal(renamed.length - 'renamed-demo'.length, xml.length - 'demo'.length);
});

test('改名保留单行布局与自闭合写法', () => {
  const renamed = renameProjectInMgp(xml, 'x1');
  assert.equal(renamed.includes('<Buses />'), true);
  assert.equal(renamed.split('\n').length, xml.split('\n').length);
  assert.equal(renamed.includes('<Project Name="x1">'), true);
});

test('单引号属性同样可以改名', () => {
  const source = "<Project Name='old' Version='4'><Devices /></Project>";
  const renamed = renameProjectInMgp(source, 'new');
  assert.equal(renamed, "<Project Name='new' Version='4'><Devices /></Project>");
});

test('缺少 Name 属性时拒绝改名', () => {
  assert.throws(() => renameProjectInMgp('<Project Version="4" />', 'x'), /缺少 Name 属性/);
});
