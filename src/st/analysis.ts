/** ST 源码静态分析（纯函数）：结构检查、赋值目标校验、符号查找。 */

import { programHeaderRange } from '../project/st.ts';

export interface StDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  start: number;
  end: number;
}

export interface StVariableInfo {
  name: string;
  typeName: string;
  comment: string;
  groupName: string;
  userAddress: string;
  wiring: string;
  isInstance: boolean;
}

export interface StContext {
  variables: Map<string, StVariableInfo>;
  functionBlocks: Set<string>;
  programs: Set<string>;
  /** 当前文件的程序名（来自数据库注册）。 */
  blockName?: string;
}

export const ST_KEYWORDS = [
  'PROGRAM',
  'END_PROGRAM',
  'IF',
  'THEN',
  'ELSIF',
  'ELSE',
  'END_IF',
  'CASE',
  'OF',
  'END_CASE',
  'FOR',
  'TO',
  'BY',
  'DO',
  'END_FOR',
  'WHILE',
  'END_WHILE',
  'REPEAT',
  'UNTIL',
  'END_REPEAT',
  'RETURN',
  'EXIT',
  'CONTINUE',
  'AND',
  'OR',
  'XOR',
  'NOT',
  'MOD',
  'TRUE',
  'FALSE',
  'VAR',
  'VAR_INPUT',
  'VAR_OUTPUT',
  'VAR_IN_OUT',
  'VAR_GLOBAL',
  'VAR_TEMP',
  'END_VAR',
  'FUNCTION',
  'END_FUNCTION',
  'FUNCTION_BLOCK',
  'END_FUNCTION_BLOCK',
  'TYPE',
  'END_TYPE',
  'STRUCT',
  'END_STRUCT',
  'RETAIN',
  'CONSTANT',
];

export const ST_TYPES = [
  'BOOL',
  'SINT',
  'INT',
  'DINT',
  'LINT',
  'USINT',
  'UINT',
  'UDINT',
  'ULINT',
  'REAL',
  'LREAL',
  'TIME',
  'DATE',
  'STRING',
  'BYTE',
  'WORD',
  'DWORD',
  'LWORD',
];

/** KLP 帮助与样例中出现的标准转换/运算函数，用于补全并减少误报。 */
export const ST_BUILTINS = [
  'ANY_TO_BOOL',
  'ANY_TO_SINT',
  'ANY_TO_INT',
  'ANY_TO_DINT',
  'ANY_TO_LINT',
  'ANY_TO_USINT',
  'ANY_TO_UINT',
  'ANY_TO_UDINT',
  'ANY_TO_ULINT',
  'ANY_TO_REAL',
  'ANY_TO_LREAL',
  'ANY_TO_TIME',
  'ANY_TO_STRING',
  'ABS',
  'SQRT',
  'LN',
  'LOG',
  'EXP',
  'SIN',
  'COS',
  'TAN',
  'ASIN',
  'ACOS',
  'ATAN',
  'MIN',
  'MAX',
  'LIMIT',
  'SEL',
  'MUX',
  'SHL',
  'SHR',
  'ROL',
  'ROR',
  'TRUNC',
  'ROUND',
  'ADD',
  'SUB',
  'MUL',
  'DIV',
  'MOD',
  'EXPT',
];

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

interface Segment {
  start: number;
  end: number;
  code: boolean;
}

function splitSegments(text: string): { segments: Segment[]; unterminated: StDiagnostic[] } {
  const segments: Segment[] = [];
  const unterminated: StDiagnostic[] = [];
  let index = 0;
  let codeStart = 0;
  const push = (start: number, end: number, code: boolean): void => {
    if (end > start) {
      segments.push({ start, end, code });
    }
  };
  while (index < text.length) {
    const ch = text[index];
    const next = text[index + 1];
    if (ch === '/' && next === '/') {
      push(codeStart, index, true);
      const end = text.indexOf('\n', index);
      const stop = end === -1 ? text.length : end;
      push(index, stop, false);
      index = stop;
      codeStart = index;
      continue;
    }
    if (ch === '(' && next === '*') {
      push(codeStart, index, true);
      const end = text.indexOf('*)', index + 2);
      if (end === -1) {
        push(index, text.length, false);
        unterminated.push({
          code: 'st.commentUnterminated',
          severity: 'error',
          message: '块注释 (* 没有对应的 *)。',
          start: index,
          end: Math.min(index + 2, text.length),
        });
        index = text.length;
        codeStart = index;
        break;
      }
      push(index, end + 2, false);
      index = end + 2;
      codeStart = index;
      continue;
    }
    if (ch === "'") {
      push(codeStart, index, true);
      let cursor = index + 1;
      let closed = false;
      while (cursor < text.length) {
        if (text[cursor] === "'") {
          if (text[cursor + 1] === "'") {
            cursor += 2;
            continue;
          }
          cursor += 1;
          closed = true;
          break;
        }
        cursor += 1;
      }
      if (!closed) {
        unterminated.push({
          code: 'st.stringUnterminated',
          severity: 'error',
          message: '字符串缺少结束的单引号。',
          start: index,
          end: Math.min(index + 1, text.length),
        });
      }
      push(index, Math.min(cursor, text.length), false);
      index = cursor;
      codeStart = index;
      continue;
    }
    index += 1;
  }
  push(codeStart, text.length, true);
  return { segments, unterminated };
}

export function programHeader(text: string): { name: string; start: number; end: number } | undefined {
  return programHeaderRange(text);
}

export function hasEndProgram(text: string): boolean {
  return /\bEND_PROGRAM\b/i.test(text);
}

/** 返回用于诊断/补全的赋值目标（`X := ...`），忽略注释与字符串。 */
export function findAssignmentTargets(text: string): Array<{ name: string; start: number; end: number }> {
  const { segments } = splitSegments(text);
  const targets: Array<{ name: string; start: number; end: number }> = [];
  for (const segment of segments) {
    if (!segment.code) {
      continue;
    }
    const slice = text.slice(segment.start, segment.end);
    const pattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:=/g;
    for (let match = pattern.exec(slice); match !== null; match = pattern.exec(slice)) {
      const name = match[1] ?? '';
      const offset = segment.start + match.index;
      targets.push({ name, start: offset, end: offset + name.length });
    }
  }
  return targets;
}

export function analyzeSt(text: string, context: StContext): StDiagnostic[] {
  const diagnostics: StDiagnostic[] = [];
  const { unterminated } = splitSegments(text);
  diagnostics.push(...unterminated);

  const header = programHeader(text);
  if (!header) {
    diagnostics.push({
      code: 'st.programHeaderMissing',
      severity: 'error',
      message: '缺少 PROGRAM <名称> 头。KLP 按该头识别程序名。',
      start: 0,
      end: Math.min(text.length, 1),
    });
  } else if (context.blockName && header.name.toLowerCase() !== context.blockName.toLowerCase()) {
    diagnostics.push({
      code: 'st.programHeaderMismatch',
      severity: 'error',
      message: `PROGRAM 头是 ${header.name}，与数据库注册名 ${context.blockName} 不一致。`,
      start: header.start,
      end: header.end,
    });
  }

  if (header && !hasEndProgram(text)) {
    diagnostics.push({
      code: 'st.endProgramMissing',
      severity: 'error',
      message: '缺少 END_PROGRAM。',
      start: Math.max(0, text.length - 1),
      end: text.length,
    });
  }

  for (const target of findAssignmentTargets(text)) {
    if (context.variables.has(target.name.toLowerCase())) {
      continue;
    }
    if (ST_KEYWORDS.some((keyword) => keyword.toLowerCase() === target.name.toLowerCase())) {
      continue;
    }
    diagnostics.push({
      code: 'st.unknownAssignmentTarget',
      severity: 'warning',
      message: `赋值目标 ${target.name} 不在工程变量表中；保存后 KLP 编译会报未定义符号。`,
      start: target.start,
      end: target.end,
    });
  }

  return diagnostics;
}

export interface WordAtOffset {
  word: string;
  start: number;
  end: number;
}

export function wordAt(text: string, offset: number): WordAtOffset | undefined {
  if (offset < 0 || offset > text.length) {
    return undefined;
  }
  let start = offset;
  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1] ?? '')) {
    start -= 1;
  }
  let end = offset;
  while (end < text.length && /[A-Za-z0-9_]/.test(text[end] ?? '')) {
    end += 1;
  }
  if (start === end) {
    return undefined;
  }
  const word = text.slice(start, end);
  if (!/^[A-Za-z_]/.test(word)) {
    return undefined;
  }
  return { word, start, end };
}

/** 收集文件中出现的标识符（去重、保留原始大小写），用于词语补全。 */
export function collectIdentifiers(text: string): string[] {
  const { segments } = splitSegments(text);
  const found = new Set<string>();
  for (const segment of segments) {
    if (!segment.code) {
      continue;
    }
    const slice = text.slice(segment.start, segment.end);
    IDENTIFIER.lastIndex = 0;
    for (let match = IDENTIFIER.exec(slice); match !== null; match = IDENTIFIER.exec(slice)) {
      found.add(match[0]);
    }
  }
  return [...found];
}
