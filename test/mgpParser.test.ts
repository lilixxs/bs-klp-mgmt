import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseMgp } from '../src/project/mgpParser.ts';

const xml = readFileSync(new URL('./fixtures/sample.mgp', import.meta.url), 'utf8');

test('读取项目名与版本', () => {
  const project = parseMgp(xml);
  assert.equal(project.name, 'demo');
  assert.equal(project.version, '4');
  assert.equal(project.ideVersion, 'V1.03.00.006');
  assert.equal(project.description, 'fixture');
});

test('读取设备与数据目录', () => {
  const project = parseMgp(xml);
  assert.equal(project.devices.length, 1);
  const device = project.devices[0];
  assert.ok(device);
  assert.equal(device.name, 'ECP');
  assert.equal(device.id, '1');
  assert.equal(device.dataDir, 'ECP_1');
  assert.equal(device.stationNumber, '1');
});

test('读取端口、IP 与协议', () => {
  const project = parseMgp(xml);
  const ports = project.devices[0]?.phyPorts ?? [];
  assert.equal(ports.length, 2);
  assert.deepEqual(ports[0]?.protocols, [{ name: 'SLBUS', role: 'Master' }]);
  assert.equal(ports[0]?.ipAddress, '192.0.2.10');
  assert.equal(ports[1]?.protocols[0]?.name, 'Modbus RTU');
});

test('单行空元素不影响解析', () => {
  assert.doesNotThrow(() => parseMgp(xml));
});

test('缺少 Project 根元素时报错', () => {
  assert.throws(() => parseMgp('<Root />'), /缺少 <Project> 根元素/);
});
