import { XMLParser } from 'fast-xml-parser';
import type { KlpDevice, KlpPhyPort, KlpProject, KlpProtocol } from '../shared/types.ts';

type Node = Record<string, unknown>;

const LIST_TAGS = new Set(['Device', 'PhyPort', 'SupportedProtocol', 'RootDevice']);

function readString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function readNode(value: unknown): Node | undefined {
  return typeof value === 'object' && value !== null ? (value as Node) : undefined;
}

function readNodes(value: unknown): Node[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is Node => typeof item === 'object' && item !== null);
  }
  const single = readNode(value);
  return single ? [single] : [];
}

function parseProtocol(node: Node): KlpProtocol {
  return {
    name: readString(node['Name']) ?? '(未命名协议)',
    role: readString(node['ProtocolRole']),
  };
}

function parsePortData(node: Node): { ipAddress?: string } {
  return { ipAddress: readString(node['IPAddr']) };
}

function parsePhyPort(node: Node): KlpPhyPort {
  const portData = readNode(node['PortData']);
  const protocols = readNode(node['SupportedProtocols']);
  return {
    id: readString(node['ID']) ?? '',
    name: readString(node['Name']) ?? '(未命名端口)',
    ...parsePortData(portData ?? {}),
    protocols: readNodes(protocols?.['SupportedProtocol']).map(parseProtocol),
  };
}

function parseDevice(node: Node): KlpDevice {
  const configuration = readNode(node['ConfigurationData']);
  const phyPorts = readNode(node['PhyPorts']);
  return {
    name: readString(node['Name']) ?? '(未命名设备)',
    id: readString(node['ID']) ?? '',
    refFamily: readString(node['RefFamily']),
    pn: readString(node['PN']),
    dataDir: readString(configuration?.['DataDir']),
    stationNumber: readString(configuration?.['StationNumber']),
    primaryCommIp: readString(configuration?.['PrimaryCommIP']),
    standbyCommIp: readString(configuration?.['StandbyCommIP']),
    phyPorts: readNodes(phyPorts?.['PhyPort']).map(parsePhyPort),
  };
}

function createParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    trimValues: true,
    allowBooleanAttributes: true,
    isArray: (name, _jpath, _isLeaf, isAttribute) =>
      isAttribute !== true && LIST_TAGS.has(name),
  });
}

/**
 * 解析 KLP 项目入口文件（*.mgp）的文本内容。
 *
 * 只读解析：返回结构化摘要，不保留原始文本。写回时不得用解析结果重建 XML，
 * 因为 .mgp 是单行、CRLF、带 `<Buses />` 这类自闭合写法的文件，整树序列化会破坏格式。
 */
export function parseMgp(xml: string): KlpProject {
  const document = readNode(createParser().parse(xml));
  const root = readNode(document?.['Project']);
  if (!root) {
    throw new Error('不是 KLP 项目入口文件：缺少 <Project> 根元素。');
  }

  const devicesNode = readNode(root['Devices']);

  return {
    name: readString(root['Name']) ?? '(未命名项目)',
    version: readString(root['Version']) ?? '',
    ideVersion: readString(root['IDEVersion']) ?? '',
    description: readString(root['Description']),
    devices: readNodes(devicesNode?.['Device']).map(parseDevice),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 只改写 `<Project ... Name="..." ...>` 起始标签内的 Name 属性值。
 * 其余字节（单行布局、CRLF、自闭合写法、缩进）保持不变。
 */
export function renameProjectInMgp(xml: string, newName: string): string {
  const open = /<Project\b[^>]*>/i.exec(xml);
  if (!open) {
    throw new Error('不是 KLP 项目入口文件：缺少 <Project> 起始标签。');
  }
  const tag = open[0];
  const nameAttribute = /\bName\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
  if (!nameAttribute) {
    throw new Error('入口文件的 <Project> 标签缺少 Name 属性，无法安全改名。');
  }
  const quote = nameAttribute[0].includes('"') ? '"' : "'";
  const start = open.index + nameAttribute.index;
  const end = start + nameAttribute[0].length;
  const replacement = `Name=${quote}${newName}${quote}`;
  return xml.slice(0, start) + replacement + xml.slice(end);
}

/** 读取入口文件中现有的工程名（不依赖完整解析，用于改名前的轻量校验）。 */
export function readProjectNameFromMgp(xml: string): string | undefined {
  const open = /<Project\b[^>]*>/i.exec(xml);
  if (!open) {
    return undefined;
  }
  const match = /\bName\s*=\s*("([^"]*)"|'([^']*)')/i.exec(open[0]);
  return match ? (match[2] ?? match[3]) : undefined;
}

export function describeMgpTimestamp(xml: string): { singleLine: boolean; crlf: boolean } {
  const crlfIndex = xml.indexOf('\r\n');
  return {
    singleLine: xml.indexOf('\n') === crlfIndex && crlfIndex >= 0,
    crlf: crlfIndex >= 0,
  };
}

/** 供测试使用的匹配辅助：返回 Name 属性当前值。 */
export function findProjectNameAttribute(xml: string): { start: number; end: number; value: string } | undefined {
  const open = /<Project\b[^>]*>/i.exec(xml);
  if (!open) {
    return undefined;
  }
  const match = /\bName\s*=\s*("([^"]*)"|'([^']*)')/i.exec(open[0]);
  if (!match) {
    return undefined;
  }
  const start = open.index + match.index;
  return { start, end: start + match[0].length, value: match[2] ?? match[3] ?? '' };
}

export { escapeRegExp };
