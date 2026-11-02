/**
 * 草稿操作的纯函数层。页面只关心“把某个实体改成什么”，
 * 具体是 add 还是 update 由这里根据目标引用决定。
 */
import type {
  ChannelInput,
  CommDeviceInput,
  DraftOp,
  EntityRef,
  ModbusParams,
  ProgramInput,
  VariableInput,
  VariableMapInput,
} from '../../../src/shared/types';

export type EntityGroup = 'variable' | 'program' | 'channel' | 'device' | 'map';

let sequence = 0;

/** 新增实体的临时引用。仅在本页面与宿主之间使用，保存后由宿主换成真实 id。 */
export function newTempId(group: EntityGroup): string {
  sequence += 1;
  return `${group}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

export function refKey(ref: EntityRef | null | undefined): string {
  if (!ref) return '';
  return ref.kind === 'existing' ? `i:${ref.id}` : `t:${ref.tempId}`;
}

export function parseRefKey(value: string): EntityRef | undefined {
  if (value.startsWith('i:')) {
    const id = Number(value.slice(2));
    return Number.isFinite(id) ? { kind: 'existing', id } : undefined;
  }
  if (value.startsWith('t:')) {
    const tempId = value.slice(2);
    return tempId ? { kind: 'new', tempId } : undefined;
  }
  return undefined;
}

export function sameRef(a: EntityRef | null | undefined, b: EntityRef | null | undefined): boolean {
  if (!a || !b) return false;
  return refKey(a) === refKey(b);
}

function matchesTarget(op: DraftOp, group: EntityGroup, target: EntityRef): boolean {
  const parts = op.kind.split('.');
  if (parts[0] !== group) return false;
  const action = parts[1];
  if (action === 'add') {
    return target.kind === 'new' && (op as { tempId: string }).tempId === target.tempId;
  }
  if (action === 'update' || action === 'delete') {
    return target.kind === 'existing' && (op as { id: number }).id === target.id;
  }
  return false;
}

function withoutTarget(ops: DraftOp[], group: EntityGroup, target: EntityRef): DraftOp[] {
  return ops.filter((op) => !matchesTarget(op, group, target));
}

export function hasEntityDraft(ops: DraftOp[], group: EntityGroup, target: EntityRef | null): boolean {
  return target !== null && ops.some((op) => matchesTarget(op, group, target));
}

/* ---------------------------- 变量 ---------------------------- */

export function setVariableDraft(ops: DraftOp[], target: EntityRef, input: VariableInput): DraftOp[] {
  const next: DraftOp =
    target.kind === 'new'
      ? { kind: 'variable.add', tempId: target.tempId, input }
      : { kind: 'variable.update', id: target.id, input };
  return [...withoutTarget(ops, 'variable', target), next];
}

export function deleteVariableDraft(ops: DraftOp[], target: EntityRef): DraftOp[] {
  const rest = withoutTarget(ops, 'variable', target);
  return target.kind === 'new' ? rest : [...rest, { kind: 'variable.delete', id: target.id }];
}

export function draftVariableInput(ops: DraftOp[], target: EntityRef): VariableInput | undefined {
  for (const op of ops) {
    if (op.kind === 'variable.add' && target.kind === 'new' && op.tempId === target.tempId) return op.input;
    if (op.kind === 'variable.update' && target.kind === 'existing' && op.id === target.id) return op.input;
  }
  return undefined;
}

/* ---------------------------- 程序 ---------------------------- */

export function setProgramDraft(ops: DraftOp[], target: EntityRef, input: ProgramInput): DraftOp[] {
  const next: DraftOp =
    target.kind === 'new'
      ? { kind: 'program.add', tempId: target.tempId, input }
      : { kind: 'program.update', id: target.id, input };
  return [...withoutTarget(ops, 'program', target), next];
}

export function deleteProgramDraft(ops: DraftOp[], target: EntityRef): DraftOp[] {
  const rest = withoutTarget(ops, 'program', target);
  return target.kind === 'new' ? rest : [...rest, { kind: 'program.delete', id: target.id }];
}

export function draftProgramInput(ops: DraftOp[], target: EntityRef): ProgramInput | undefined {
  for (const op of ops) {
    if (op.kind === 'program.add' && target.kind === 'new' && op.tempId === target.tempId) return op.input;
    if (op.kind === 'program.update' && target.kind === 'existing' && op.id === target.id) return op.input;
  }
  return undefined;
}

/* ---------------------------- 通道 ---------------------------- */

export function setChannelDraft(ops: DraftOp[], target: EntityRef, input: ChannelInput): DraftOp[] {
  const next: DraftOp =
    target.kind === 'new'
      ? { kind: 'channel.add', tempId: target.tempId, input }
      : { kind: 'channel.update', id: target.id, input };
  return [...withoutTarget(ops, 'channel', target), next];
}

export function deleteChannelDraft(ops: DraftOp[], target: EntityRef): DraftOp[] {
  const rest = withoutTarget(ops, 'channel', target);
  return target.kind === 'new' ? rest : [...rest, { kind: 'channel.delete', id: target.id }];
}

export function draftChannelInput(ops: DraftOp[], target: EntityRef): ChannelInput | undefined {
  for (const op of ops) {
    if (op.kind === 'channel.add' && target.kind === 'new' && op.tempId === target.tempId) return op.input;
    if (op.kind === 'channel.update' && target.kind === 'existing' && op.id === target.id) return op.input;
  }
  return undefined;
}

/* ---------------------------- 通讯设备 ---------------------------- */

export function setDeviceDraft(ops: DraftOp[], target: EntityRef, input: CommDeviceInput): DraftOp[] {
  const next: DraftOp =
    target.kind === 'new'
      ? { kind: 'device.add', tempId: target.tempId, input }
      : { kind: 'device.update', id: target.id, input };
  return [...withoutTarget(ops, 'device', target), next];
}

export function deleteDeviceDraft(ops: DraftOp[], target: EntityRef): DraftOp[] {
  const rest = withoutTarget(ops, 'device', target);
  return target.kind === 'new' ? rest : [...rest, { kind: 'device.delete', id: target.id }];
}

export function draftDeviceInput(ops: DraftOp[], target: EntityRef): CommDeviceInput | undefined {
  for (const op of ops) {
    if (op.kind === 'device.add' && target.kind === 'new' && op.tempId === target.tempId) return op.input;
    if (op.kind === 'device.update' && target.kind === 'existing' && op.id === target.id) return op.input;
  }
  return undefined;
}

export function emptyModbusParams(): ModbusParams {
  return {
    transMode: 0,
    station: 0,
    transDelay: 0,
    shortFormat: 0,
    longFormat: 0,
    floatFormat: 0,
    longLongFormat: 0,
    doubleFloatFormat: 0,
    singleCmg: 0,
    boolBlockSize: 0,
    regBlockSize: 0,
    reserved1: 0,
  };
}

/* ---------------------------- 变量映射 ---------------------------- */

export function setMapDraft(ops: DraftOp[], target: EntityRef, input: VariableMapInput): DraftOp[] {
  const next: DraftOp =
    target.kind === 'new'
      ? { kind: 'map.add', tempId: target.tempId, input }
      : { kind: 'map.update', id: target.id, input };
  return [...withoutTarget(ops, 'map', target), next];
}

export function deleteMapDraft(ops: DraftOp[], target: EntityRef): DraftOp[] {
  const rest = withoutTarget(ops, 'map', target);
  return target.kind === 'new' ? rest : [...rest, { kind: 'map.delete', id: target.id }];
}

export function draftMapInput(ops: DraftOp[], target: EntityRef): VariableMapInput | undefined {
  for (const op of ops) {
    if (op.kind === 'map.add' && target.kind === 'new' && op.tempId === target.tempId) return op.input;
    if (op.kind === 'map.update' && target.kind === 'existing' && op.id === target.id) return op.input;
  }
  return undefined;
}

/* ---------------------------- 工程改名 ---------------------------- */

export function setProjectRename(ops: DraftOp[], newName: string): DraftOp[] {
  const rest = ops.filter((op) => op.kind !== 'project.rename');
  const trimmed = newName.trim();
  return trimmed ? [...rest, { kind: 'project.rename', newName: trimmed }] : rest;
}

export function draftProjectRename(ops: DraftOp[]): string | undefined {
  for (const op of ops) {
    if (op.kind === 'project.rename') return op.newName;
  }
  return undefined;
}

/* ---------------------------- 有效视图绑定 ---------------------------- */

export interface AddOpRef {
  tempId: string;
  name: string;
}

/** 按 ops 顺序列出新增操作，用于把 effective 里的新增行对回可编辑的草稿目标。 */
export function addOpRefs(ops: DraftOp[], group: EntityGroup): AddOpRef[] {
  const refs: AddOpRef[] = [];
  for (const op of ops) {
    switch (op.kind) {
      case 'variable.add':
        if (group === 'variable') refs.push({ tempId: op.tempId, name: op.input.name });
        break;
      case 'program.add':
        if (group === 'program') refs.push({ tempId: op.tempId, name: op.input.name });
        break;
      case 'channel.add':
        if (group === 'channel') refs.push({ tempId: op.tempId, name: op.input.name });
        break;
      case 'device.add':
        if (group === 'device') refs.push({ tempId: op.tempId, name: op.input.name });
        break;
      case 'map.add':
        if (group === 'map') refs.push({ tempId: op.tempId, name: '' });
        break;
      default:
        break;
    }
  }
  return refs;
}

export interface BoundRow<T> {
  row: T;
  /** null 表示无法定位到草稿操作（宿主给的 id 既不在原库也不对应任何新增操作）。 */
  target: EntityRef | null;
}

function defaultSignature(row: { id: number }): string {
  const name = (row as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

/**
 * 把 plan.effective 中的行对回草稿目标：
 * id 在原库里的按 existing 处理；其余是本次新增，按名称（或调用方给定的签名）匹配 add 操作。
 * 匹配不上的行保持 target=null，页面据此禁用编辑/删除，避免误改别的操作。
 */
export function bindEffectiveRows<T extends { id: number }>(
  rows: T[],
  existingIds: Set<number>,
  addRefs: AddOpRef[],
  signature: (row: T) => string = defaultSignature,
): BoundRow<T>[] {
  const queue = [...addRefs];
  return rows.map((row) => {
    if (existingIds.has(row.id)) {
      return { row, target: { kind: 'existing', id: row.id } };
    }
    const wanted = signature(row);
    const index = queue.findIndex((ref) => ref.name === wanted);
    if (index < 0) {
      return { row, target: null };
    }
    const [ref] = queue.splice(index, 1);
    return { row, target: ref ? { kind: 'new', tempId: ref.tempId } : null };
  });
}
