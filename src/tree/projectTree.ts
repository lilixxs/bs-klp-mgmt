import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Diagnostic, ProjectSnapshot } from '../shared/types.ts';
import { dbDeviceLayout } from '../project/session.ts';

export interface TreeNode {
  key: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: vscode.ThemeIcon;
  expanded?: boolean;
  command?: vscode.Command;
  children?: TreeNode[];
}

function severityIcon(severity: Diagnostic['severity']): string {
  switch (severity) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    default:
      return 'info';
  }
}

function variableTypeName(snapshot: ProjectSnapshot, variable: { varInstanceId: number; defTypeId: number }): string {
  const db = snapshot.db;
  if (!db) {
    return '?';
  }
  if (variable.varInstanceId === 2) {
    return db.pous.find((pou) => pou.id === variable.defTypeId)?.name ?? `POU #${variable.defTypeId}`;
  }
  return db.definitionTypes.find((type) => type.id === variable.defTypeId)?.name ?? `类型 #${variable.defTypeId}`;
}

function groupName(snapshot: ProjectSnapshot, groupId: number): string {
  return snapshot.db?.groups.find((group) => group.id === groupId)?.name ?? `未分组(#${groupId})`;
}

function deviceName(snapshot: ProjectSnapshot, deviceId: number): string {
  return snapshot.db?.devices.find((device) => device.id === deviceId)?.name ?? `缺失设备(#${deviceId})`;
}

function variableName(snapshot: ProjectSnapshot, symbolId: number): string {
  return snapshot.db?.variables.find((variable) => variable.id === symbolId)?.name ?? `缺失变量(#${symbolId})`;
}

function buildDiagnostics(snapshot: ProjectSnapshot): TreeNode {
  const items = snapshot.diagnostics;
  const errors = items.filter((item) => item.severity === 'error').length;
  const warnings = items.filter((item) => item.severity === 'warning').length;
  return {
    key: 'diagnostics',
    label: '诊断',
    description: errors + warnings > 0 ? `${errors} 错误 · ${warnings} 警告` : '无问题',
    icon: new vscode.ThemeIcon(items.length > 0 ? 'bell' : 'pass'),
    expanded: errors > 0,
    children: items.map((item, index) => ({
      key: `diagnostic-${index}`,
      label: item.message,
      description: item.code,
      tooltip: item.target ? `${item.message}\n${item.target}` : item.message,
      icon: new vscode.ThemeIcon(severityIcon(item.severity)),
    })),
  };
}

export function buildProjectTree(snapshot: ProjectSnapshot, openCommand: string, openFileCommand: string): TreeNode[] {
  const db = snapshot.db;
  const nodes: TreeNode[] = [
    {
      key: 'entry',
      label: '入口文件',
      description: path.basename(snapshot.entryPath),
      tooltip: snapshot.entryPath,
      icon: new vscode.ThemeIcon('file-code'),
      command: {
        command: openFileCommand,
        title: '打开入口文件',
        arguments: [snapshot.entryPath],
      },
    },
    {
      key: 'db',
      label: '设备数据库',
      description: snapshot.dbPath ? path.basename(snapshot.dbPath) : '未找到',
      tooltip: snapshot.dbPath ?? '设备目录中缺少 PrjLibrary.mdb',
      icon: new vscode.ThemeIcon(snapshot.dbPath ? 'database' : 'warning'),
      command: snapshot.dbPath
        ? { command: openFileCommand, title: '打开数据库', arguments: [snapshot.dbPath] }
        : undefined,
    },
  ];

  if (db) {
    const groups = new Map<number, typeof db.variables>();
    for (const variable of db.variables) {
      const list = groups.get(variable.groupId) ?? [];
      list.push(variable);
      groups.set(variable.groupId, list);
    }
    const groupNodes: TreeNode[] = [...groups.entries()]
      .sort((a, b) => groupName(snapshot, a[0]).localeCompare(groupName(snapshot, b[0])))
      .map(([groupId, variables]) => ({
        key: `group-${groupId}`,
        label: groupName(snapshot, groupId),
        description: `${variables.length}`,
        icon: new vscode.ThemeIcon('symbol-variable'),
        children: variables
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((variable) => ({
            key: `variable-${variable.id}`,
            label: variable.name,
            description: `${variableTypeName(snapshot, variable)}${variable.comment ? ` · ${variable.comment}` : ''}`,
            tooltip: [
              `变量 #${variable.id}`,
              `类型：${variableTypeName(snapshot, variable)}`,
              `分组：${groupName(snapshot, variable.groupId)}`,
              variable.userAddress ? `本机地址：${variable.userAddress}` : '',
              variable.wiring ? `I/O 组态：${variable.wiring}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
            icon: new vscode.ThemeIcon(variable.varInstanceId === 2 ? 'symbol-class' : 'symbol-field'),
            command: { command: openCommand, title: '编辑变量', arguments: ['variables', variable.id] },
          })),
      }));

    const programLayout = dbDeviceLayout(snapshot);
    const programNodes: TreeNode[] = db.programs.map((program, index) => {
      const source = programLayout?.programs[index];
      const language = db.languages.find((item) => item.id === program.languageId)?.name ?? `#${program.languageId}`;
      return {
        key: `program-${program.id}`,
        label: program.name,
        description: `${language}${source?.missing ? ' · 源文件缺失' : ''}`,
        tooltip: source?.path ?? `${program.name}.stf 未找到`,
        icon: new vscode.ThemeIcon(language.toUpperCase() === 'ST' ? 'symbol-method' : 'lock'),
        command: { command: openCommand, title: '编辑程序', arguments: ['programs', program.id] },
      };
    });

    const channelNodes: TreeNode[] = db.channels.map((channel) => ({
      key: `channel-${channel.id}`,
      label: channel.name,
      description: `${channel.protocol || '协议未填'} · 端口 ${channel.portNum}`,
      icon: new vscode.ThemeIcon('plug'),
      children: db.devices
        .filter((device) => device.channelId === channel.id)
        .map((device) => ({
          key: `comm-device-${device.id}`,
          label: device.name,
          description: device.modbus ? `站号 ${device.modbus.station}` : device.protocol,
          icon: new vscode.ThemeIcon('circuit-board'),
          command: { command: openCommand, title: '编辑通讯设备', arguments: ['comm', device.id] },
        })),
    }));

    nodes.push(
      {
        key: 'variables',
        label: '变量',
        description: `${db.variables.length}`,
        icon: new vscode.ThemeIcon('symbol-variable'),
        expanded: true,
        children: groupNodes,
      },
      {
        key: 'programs',
        label: '程序',
        description: `${db.programs.length}`,
        icon: new vscode.ThemeIcon('code'),
        expanded: true,
        children: programNodes,
      },
      {
        key: 'comm',
        label: '通讯',
        description: `${db.channels.length} 通道 · ${db.devices.length} 设备 · ${db.maps.length} 映射`,
        icon: new vscode.ThemeIcon('radio-tower'),
        children: [
          ...channelNodes,
          {
            key: 'maps',
            label: '变量映射',
            description: `${db.maps.length}`,
            icon: new vscode.ThemeIcon('list-unordered'),
            children: db.maps.map((map) => ({
              key: `map-${map.id}`,
              label: `${deviceName(snapshot, map.deviceId)} → ${variableName(snapshot, map.symbolId)}`,
              description: map.address,
              tooltip: `映射 #${map.id}\n地址：${map.address}\n访问：${map.access}`,
              icon: new vscode.ThemeIcon('link'),
              command: { command: openCommand, title: '编辑变量映射', arguments: ['comm', map.id] },
            })),
          },
        ],
      },
    );
  } else {
    nodes.push({
      key: 'no-db',
      label: '数据库未读取',
      description: '无法浏览变量、程序与通讯',
      icon: new vscode.ThemeIcon('warning'),
    });
  }

  for (const device of snapshot.devices) {
    nodes.push({
      key: `device-${device.deviceName}`,
      label: `设备 ${device.deviceName}`,
      description: device.dataDir ? `DataDir ${device.dataDir}` : '缺少 DataDir',
      icon: new vscode.ThemeIcon('server'),
      children: device.programs
        .filter((program) => program.path)
        .map((program) => ({
          key: `source-${program.path}`,
          label: path.basename(program.path ?? ''),
          description: program.missing ? '缺失' : '源文件',
          tooltip: program.path,
          icon: new vscode.ThemeIcon('file-code'),
          command: program.path
            ? { command: openFileCommand, title: '打开源文件', arguments: [program.path] }
            : undefined,
        })),
    });
  }

  nodes.push(buildDiagnostics(snapshot));
  return nodes;
}

export class ProjectTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  private root: TreeNode | undefined;
  private projectName = 'KLP 项目';
  private expanded = true;

  readonly onDidChangeTreeData = this.changed.event;

  setTree(nodes: TreeNode[]): void {
    this.root = {
      key: 'root',
      label: `项目：${this.projectName}`,
      description: 'KLP',
      icon: new vscode.ThemeIcon('root-folder'),
      expanded: this.expanded,
      children: nodes,
    };
    this.changed.fire(undefined);
  }

  setProjectName(name: string): void {
    this.projectName = name;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const collapsible =
      node.children !== undefined
        ? node.expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, collapsible);
    item.id = node.key;
    item.description = node.description;
    item.tooltip = node.tooltip ?? node.label;
    item.iconPath = node.icon;
    item.command = node.command;
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (node) {
      return node.children ?? [];
    }
    return this.root ? [this.root] : [];
  }
}
