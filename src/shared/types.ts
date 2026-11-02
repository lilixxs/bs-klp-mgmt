/** 项目模型与编辑草稿模型。扩展宿主与 webview 共用，禁止 import vscode 或 DOM。 */

export interface KlpProtocol {
  name: string;
  role?: string;
}

export interface KlpPhyPort {
  id: string;
  name: string;
  ipAddress?: string;
  protocols: KlpProtocol[];
}

export interface KlpDevice {
  name: string;
  id: string;
  refFamily?: string;
  pn?: string;
  dataDir?: string;
  stationNumber?: string;
  primaryCommIp?: string;
  standbyCommIp?: string;
  phyPorts: KlpPhyPort[];
}

export interface KlpProject {
  name: string;
  version: string;
  ideVersion: string;
  description?: string;
  devices: KlpDevice[];
}

export interface IdName {
  id: number;
  name: string;
}

export interface DefinitionType extends IdName {
  dataType: number;
  stringSize: number;
  crc: number;
  refLibrary: number | null;
}

export interface VariableRecord {
  id: number;
  name: string;
  comment: string;
  alias: string;
  varInstanceId: number;
  resourcePouId: number;
  scopeId: number;
  defTypeId: number;
  stringSize: number;
  attributeId: number;
  directionId: number;
  groupId: number;
  userAddress: string;
  wiring: string;
  isRetain: boolean;
  order: number;
  hasDimension: boolean;
  initialValue: string;
  refLibrary: number | null;
  hook: number | null;
  crcInitValueDim: number;
  crcInitValueType: number;
  /** RefStatus 原文；数据库 NULL 必须保留为 null，不能写成空字符串。 */
  status: string | null;
}

export interface ProgramRecord {
  id: number;
  name: string;
  comment: string;
  languageId: number;
  resourceId: number;
  order: number;
  fatherId: number;
  readOnly: boolean;
  generateSymbMon: boolean;
  encrypted: boolean;
  /** KLP 的 POU 本地化/分类字段；新增程序时从同资源现有 ST 程序克隆。 */
  refLocalization: number;
  refPouGroup: number;
  generateDebugInfo: boolean;
  is1499: boolean;
  /** POUs 中有 type=1 记录，但 Programs 表缺少对应行。此类程序不能安全更新/删除。 */
  hasProgramRow: boolean;
}

export interface ChannelRecord {
  id: number;
  portNum: number;
  name: string;
  protocol: string;
  interval: number;
  timeout: number;
  retry: number;
  watchtime: number;
  destIp: string;
  destPort: number;
  tcpudp: number;
  baudrate: string;
  databits: string;
  parity: string;
  stopbits: string;
  comments: string;
}

export interface ModbusParams {
  transMode: number;
  station: number;
  transDelay: number;
  shortFormat: number;
  longFormat: number;
  floatFormat: number;
  longLongFormat: number;
  doubleFloatFormat: number;
  singleCmg: number;
  boolBlockSize: number;
  regBlockSize: number;
  reserved1: number;
}

export interface CommDeviceRecord {
  id: number;
  channelId: number;
  name: string;
  protocol: string;
  interval: number;
  comments: string;
  modbus?: ModbusParams;
}

export interface VariableMapRecord {
  id: number;
  deviceId: number;
  symbolId: number;
  address: string;
  access: number;
}

export interface IoBindingRecord {
  symbolId: number;
  refInstance: number;
  refDevice: number;
  physicalOrder: number;
  order: number;
}

export interface ResourceRecord {
  id: number;
  configurationId: number;
  name: string;
  address: string;
}

export interface PouIndexEntry {
  id: number;
  name: string;
  typeId: number;
}

export interface DbSnapshot {
  /** Project.Name（设备库内部名称，通常 <设备名>_<ID>），与 .mgp 工程名不是同一概念。 */
  dbProjectName: string;
  variables: VariableRecord[];
  groups: IdName[];
  definitionTypes: DefinitionType[];
  varInstances: IdName[];
  scopes: IdName[];
  directions: IdName[];
  attributes: IdName[];
  languages: IdName[];
  programs: ProgramRecord[];
  /** 全部 POU（含函数/功能块），用于解析功能块实例的显示类型。 */
  pous: PouIndexEntry[];
  channels: ChannelRecord[];
  devices: CommDeviceRecord[];
  maps: VariableMapRecord[];
  ioBindings: IoBindingRecord[];
  resources: ResourceRecord[];
  resourceName: string;
  configurationName: string;
}

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  target?: string;
}

export interface FileStamp {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface ProgramSource {
  /** .stf 绝对路径；文件缺失时为 undefined。 */
  path?: string;
  /** 解码后的 ST 文本；缺失或非 ST 时为 undefined。 */
  text?: string;
  /** 文件字节的 SHA-256，用于冲突检测。 */
  sha256?: string;
  encoding: 'gbk' | 'utf-8';
  /** 原文件是否带 UTF-8 BOM；写回时保留，避免静默改变编码。 */
  bom?: boolean;
  /** 解码是否出现替换字符（无法无损写回）。 */
  lossy?: boolean;
  missing: boolean;
}

export interface DeviceLayout {
  deviceName: string;
  dataDir?: string;
  dataDirPath?: string;
  configName?: string;
  resourceName?: string;
  resourcePath?: string;
  resourceId?: number;
  /** 本设备数据库路径；用于把数据库与资源目录配对。 */
  dbPath?: string;
  programs: ProgramSource[];
}

export interface ProjectSnapshot {
  entryPath: string;
  projectDir: string;
  /** 打开工程时解析出的物理根目录（realpath），用于 junction/symlink 越界防护。 */
  physicalRoot?: string;
  /** 打开时已发现的物理越界路径；writable=false 时所有保存都应被拒绝。 */
  pathSafety?: { writable: boolean; unsafePaths: string[]; message?: string };
  project: KlpProject;
  dbPath?: string;
  db?: DbSnapshot;
  devices: DeviceLayout[];
  /** 入口 .mgp、数据库、.stf 的时间戳与哈希，用于保存前冲突检测。 */
  stamps: FileStamp[];
  diagnostics: Diagnostic[];
  loadedAt: number;
}

/* ------------------------------------------------------------------ */
/* 草稿（未保存修改）                                                    */
/* ------------------------------------------------------------------ */

export type EntityRef = { kind: 'existing'; id: number } | { kind: 'new'; tempId: string };

export interface VariableInput {
  name: string;
  comment: string;
  groupId: number;
  defTypeId: number;
  directionId: number;
  attributeId: number;
  varInstanceId: number;
  resourcePouId: number;
  scopeId: number;
  userAddress: string;
  wiring: string;
  isRetain: boolean;
  initialValue: string;
}

export interface ProgramInput {
  name: string;
  comment: string;
  languageId: number;
  resourceId: number;
  /** 仅新增程序时使用；省略或为空时写入 PROGRAM/END_PROGRAM 模板。 */
  sourceText?: string;
}

export interface ChannelInput {
  name: string;
  portNum: number;
  protocol: string;
  interval: number;
  timeout: number;
  retry: number;
  watchtime: number;
  destIp: string;
  destPort: number;
  tcpudp: number;
  baudrate: string;
  databits: string;
  parity: string;
  stopbits: string;
  comments: string;
}

export interface CommDeviceInput {
  name: string;
  channelRef: EntityRef;
  protocol: string;
  interval: number;
  comments: string;
  modbus: ModbusParams;
}

export interface VariableMapInput {
  deviceRef: EntityRef;
  symbolRef: EntityRef;
  address: string;
  access: number;
}

export type DraftOp =
  | { kind: 'variable.add'; tempId: string; input: VariableInput }
  | { kind: 'variable.update'; id: number; input: VariableInput }
  | { kind: 'variable.delete'; id: number }
  | { kind: 'program.add'; tempId: string; input: ProgramInput }
  | { kind: 'program.update'; id: number; input: ProgramInput }
  | { kind: 'program.delete'; id: number }
  | { kind: 'channel.add'; tempId: string; input: ChannelInput }
  | { kind: 'channel.update'; id: number; input: ChannelInput }
  | { kind: 'channel.delete'; id: number }
  | { kind: 'device.add'; tempId: string; input: CommDeviceInput }
  | { kind: 'device.update'; id: number; input: CommDeviceInput }
  | { kind: 'device.delete'; id: number }
  | { kind: 'map.add'; tempId: string; input: VariableMapInput }
  | { kind: 'map.update'; id: number; input: VariableMapInput }
  | { kind: 'map.delete'; id: number }
  | { kind: 'project.rename'; newName: string };

export interface Draft {
  ops: DraftOp[];
}

/* 保存计划：草稿解析后的确定性结果，供 UI 展示与保存执行共用。 */
export interface PlannedDbInsert {
  table: 'Symbols' | 'POUs' | 'Programs' | 'GWChannel' | 'GWDevice' | 'GWDeviceModbus' | 'GWVariableMap';
  key: string;
}

export interface DraftPlan {
  diagnostics: Diagnostic[];
  canSave: boolean;
  summary: string[];
  /**
   * 需要写回的 .stf 最终内容（新增、改名或内容替换）。
   * 改名时这里就是新路径的完整文本，保存层不再二次读盘改写，避免与变量改名互相覆盖。
   */
  programWrites: Array<{
    path: string;
    text: string;
    encoding: 'gbk' | 'utf-8';
    previousSha256?: string;
    /** 原路径；用于识别改名和同名文件占用。原地更新时等于 path。 */
    fromPath?: string;
    /** 是否保留原文件的 UTF-8 BOM。 */
    bom?: boolean;
  }>;
  /** 程序改名：保存层据此删除旧路径。源文件内容以 programWrites 为准。 */
  programMoves: Array<{ fromPath: string; toPath: string; newName: string; encoding: 'gbk' | 'utf-8' }>;
  /** 需要删除的 .stf 文件。 */
  programDeletes: Array<{ path: string }>;
  /** 工程整体改名：新目录与新入口文件。 */
  projectRename?: { fromDir: string; toDir: string; fromEntry: string; toEntry: string; newName: string };
  /** 发送给 Jet 助手的数据库操作，顺序固定。 */
  dbOps: DbOperation[];
  /** 保存后应被替换/更新的内存对象，用于 UI 预览。 */
  effective: EffectiveState;
}

/** 数据库整行内容（自动编号列除外），由 save 层从草稿解析得到。 */
export interface VariableRow {
  name: string;
  comment: string;
  alias: string;
  varInstanceId: number;
  resourcePouId: number;
  scopeId: number;
  defTypeId: number;
  stringSize: number;
  attributeId: number;
  directionId: number;
  groupId: number;
  userAddress: string;
  wiring: string;
  isRetain: boolean;
  order: number;
  hasDimension: boolean;
  initialValue: string;
  refLibrary: number | null;
  hook: number | null;
  crcInitValueDim: number;
  crcInitValueType: number;
  status: string | null;
}

export interface ProgramRow {
  name: string;
  comment: string;
  languageId: number;
  resourceId: number;
  order: number;
  readOnly: boolean;
  generateSymbMon: boolean;
  refLocalization: number;
  refPouGroup: number;
  generateDebugInfo: boolean;
  is1499: boolean;
}

export interface ChannelRow extends ChannelInput {
  id: number;
}

export interface DeviceRow extends Omit<CommDeviceInput, 'channelRef'> {
  id: number;
  channelRef: EntityRef;
}

export interface MapRow extends Omit<VariableMapInput, 'deviceRef' | 'symbolRef'> {
  id: number;
  deviceRef: EntityRef;
  symbolRef: EntityRef;
}

export type DbOperation =
  | { op: 'variable.insert'; tempId: string; row: VariableRow }
  | { op: 'variable.update'; id: number; row: VariableRow }
  | { op: 'variable.delete'; id: number }
  | { op: 'program.insert'; tempId: string; row: ProgramRow }
  | { op: 'program.update'; id: number; row: ProgramRow }
  | { op: 'program.delete'; id: number }
  | { op: 'channel.insert'; tempId: string; row: ChannelRow }
  | { op: 'channel.update'; id: number; row: ChannelInput }
  | { op: 'channel.delete'; id: number }
  | { op: 'device.insert'; tempId: string; row: DeviceRow }
  | { op: 'device.update'; id: number; row: DeviceRow }
  | { op: 'device.delete'; id: number }
  | { op: 'map.insert'; tempId: string; row: MapRow }
  | { op: 'map.update'; id: number; row: MapRow }
  | { op: 'map.delete'; id: number };

export interface EffectiveState {
  variables: VariableRecord[];
  programs: ProgramRecord[];
  channels: ChannelRecord[];
  devices: CommDeviceRecord[];
  maps: VariableMapRecord[];
}

export interface ViewState {
  snapshot: ProjectSnapshot;
  draft: Draft;
  plan: DraftPlan;
  busy: boolean;
  busyMessage?: string;
  /** 由树/命令指定的初始标签页。 */
  activeTab?: 'variables' | 'programs' | 'comm' | 'project' | 'diagnostics';
  /** 需要选中的对象（变量/程序/通道等）。 */
  focus?: { kind: string; id?: number };
}

/* ------------------------------------------------------------------ */
/* webview 消息协议                                                     */
/* ------------------------------------------------------------------ */

export type HostToWebMessage =
  | { type: 'state'; payload: ViewState }
  | { type: 'notice'; payload: { severity: Severity; message: string } }
  | { type: 'saved'; payload: { snapshot: ProjectSnapshot; message: string } };

export type WebToHostMessage =
  | { type: 'ready' }
  | { type: 'replaceDraft'; payload: { ops: DraftOp[] } }
  | { type: 'save' }
  | { type: 'discard' }
  | { type: 'reload' }
  | { type: 'openProgram'; payload: { id: number } };
