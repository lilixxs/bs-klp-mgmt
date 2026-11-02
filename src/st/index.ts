import type { ProjectSnapshot } from '../shared/types.ts';
import type { StContext, StVariableInfo } from './analysis.ts';

export function buildStContext(snapshot: ProjectSnapshot | undefined, blockName?: string): StContext {
  const variables = new Map<string, StVariableInfo>();
  const functionBlocks = new Set<string>();
  const programs = new Set<string>();
  const db = snapshot?.db;
  if (!db) {
    return { variables, functionBlocks, programs, blockName };
  }
  const groupName = (id: number): string => db.groups.find((group) => group.id === id)?.name ?? '';
  const typeName = (variable: { varInstanceId: number; defTypeId: number }): string => {
    if (variable.varInstanceId === 2) {
      return db.pous.find((pou) => pou.id === variable.defTypeId)?.name ?? '';
    }
    return db.definitionTypes.find((type) => type.id === variable.defTypeId)?.name ?? '';
  };
  for (const variable of db.variables) {
    variables.set(variable.name.toLowerCase(), {
      name: variable.name,
      typeName: typeName(variable),
      comment: variable.comment,
      groupName: groupName(variable.groupId),
      userAddress: variable.userAddress,
      wiring: variable.wiring,
      isInstance: variable.varInstanceId === 2,
    });
  }
  for (const pou of db.pous) {
    if (pou.typeId === 3) {
      functionBlocks.add(pou.name);
    }
  }
  for (const program of db.programs) {
    programs.add(program.name);
  }
  return { variables, functionBlocks, programs, blockName };
}

export function variableMarkdown(info: StVariableInfo): string {
  const lines = [
    `**${info.name}** ${info.typeName ? `· \`${info.typeName}\`` : ''}`,
    '',
    info.comment ? `注释：${info.comment}` : '注释：（空）',
    info.groupName ? `变量组：${info.groupName}` : '',
    info.userAddress ? `本机地址：\`${info.userAddress}\`` : '',
    info.wiring ? `I/O 组态：\`${info.wiring}\`` : '',
    info.isInstance ? '类别：功能块实例' : '类别：普通变量',
  ];
  return lines.filter((line) => line !== '').join('\n\n');
}
