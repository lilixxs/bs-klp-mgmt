import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { encodeGbk } from '../../src/util/encoding.ts';
import { createFixtureDatabase, sampleRows } from './fixture.ts';

export const MGP_XML = [
  "<?xml version='1.0' encoding='utf-8'?>",
  '<Project Name="DEMO"><Version>4</Version><IDEVersion>V1.03.00.006</IDEVersion><Description>fixture project</Description><Buses /><Devices><Device Name="ECP" ID="1" RefFamily="6" PN="SL-default-000-xxxx"><ConfigurationData><StationNumber>1</StationNumber><DataDir>ECP_1</DataDir><Redundancy>No</Redundancy></ConfigurationData><PhyPorts><PhyPort ID="2" Name="Eth1" RefConnectedBus="0"><PortData RefPortType="6" PortName="Eth1"><IPAddr>192.0.2.10</IPAddr></PortData><SupportedProtocols><SupportedProtocol RefProtocolType="8" Name="SLBUS" ProtocolRole="Master" /></SupportedProtocols></PhyPort></PhyPorts></Device></Devices><RootDevices><RootDevice ID="1" SLID="201" Name="ECP" /></RootDevices></Project>',
].join('\r\n');

export const ST_SOURCE = ['PROGRAM MAIN', '(* 中文注释：心跳计数 *)', 'HB01 := HB01 + 1;', 'AI_01 := AI_01 + 0.5;', 'END_PROGRAM', ''].join('\r\n');

export interface SyntheticProject {
  dir: string;
  entryPath: string;
  dbPath: string;
  stPath: string;
}

export async function createSyntheticProject(root: string, name = 'DEMO'): Promise<SyntheticProject> {
  const dir = path.join(root, name);
  const dataDir = path.join(dir, 'ECP_1');
  const resourceDir = path.join(dataDir, 'Config1', 'Resource1');
  await mkdir(resourceDir, { recursive: true });
  const entryPath = path.join(dir, `${name}.mgp`);
  await writeFile(entryPath, MGP_XML.replace('Name="DEMO"', `Name="${name}"`), 'utf8');
  const dbPath = await createFixtureDatabase(dataDir, sampleRows());
  const stPath = path.join(resourceDir, 'MAIN.stf');
  await writeFile(stPath, encodeGbk(ST_SOURCE));
  return { dir, entryPath, dbPath, stPath };
}
