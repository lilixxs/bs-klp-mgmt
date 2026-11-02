import * as vscode from 'vscode';
import type { ProjectSnapshot } from '../shared/types.ts';

/** 变量定义的只读虚拟文档：Go to Definition 的目标。 */
export class SymbolDocProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly getSnapshot: () => ProjectSnapshot | undefined) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const name = decodeURIComponent(uri.path.replace(/^\//, ''));
    const snapshot = this.getSnapshot();
    const db = snapshot?.db;
    if (!db) {
      return `KLP 工程未打开，无法显示变量 ${name}。`;
    }
    const variable = db.variables.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!variable) {
      return `变量 ${name} 不存在（可能已被删除）。`;
    }
    const group = db.groups.find((item) => item.id === variable.groupId)?.name ?? '(未分组)';
    const typeName =
      variable.varInstanceId === 2
        ? db.pous.find((pou) => pou.id === variable.defTypeId)?.name ?? `POU #${variable.defTypeId}`
        : db.definitionTypes.find((type) => type.id === variable.defTypeId)?.name ?? `类型 #${variable.defTypeId}`;
    const direction = db.directions.find((item) => item.id === variable.directionId)?.name ?? '';
    const attribute = db.attributes.find((item) => item.id === variable.attributeId)?.name ?? '';
    const maps = db.maps.filter((map) => map.symbolId === variable.id);
    const io = db.ioBindings.filter((binding) => binding.symbolId === variable.id);
    const lines = [
      `变量 ${variable.name}`,
      '',
      `RefSymbols：${variable.id}`,
      `类型：${typeName}${variable.varInstanceId === 2 ? '（功能块实例）' : ''}`,
      `变量组：${group}`,
      `方向：${direction || '（空）'}`,
      `属性：${attribute || '（空）'}`,
      `注释：${variable.comment || '（空）'}`,
      `本机地址：${variable.userAddress || '（空）'}`,
      `I/O 组态：${variable.wiring || '（空）'}`,
      `初始值：${variable.initialValue || '（空）'}`,
      `保持：${variable.isRetain ? '是' : '否'}`,
      '',
      `通讯映射：${maps.length} 条`,
      ...maps.map((map) => {
        const device = db.devices.find((item) => item.id === map.deviceId)?.name ?? `缺失设备 #${map.deviceId}`;
        return `  - ${device} @ ${map.address}（访问 ${map.access}）`;
      }),
      `物理 I/O 绑定：${io.length} 条`,
      ...io.map((binding) => `  - 实例 ${binding.refInstance}，物理序号 ${binding.physicalOrder}`),
      '',
      '该文档由 KLP 插件根据设备数据库生成，只读。',
    ];
    return lines.join('\n');
  }
}
