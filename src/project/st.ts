/** ST（结构化文本）源码处理：分词、引用查找与安全替换。 */

export interface TextSegment {
  start: number;
  end: number;
  /** true 表示可执行代码；false 表示注释或字符串字面量。 */
  code: boolean;
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

/** 将源码拆成代码段/非代码段（注释、字符串）。保持原文偏移，便于定点替换。 */
export function splitCodeSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
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
      let depth = 1;
      let cursor = index + 2;
      while (cursor < text.length && depth > 0) {
        if (text[cursor] === '(' && text[cursor + 1] === '*') {
          depth += 1;
          cursor += 2;
          continue;
        }
        if (text[cursor] === '*' && text[cursor + 1] === ')') {
          depth -= 1;
          cursor += 2;
          continue;
        }
        cursor += 1;
      }
      push(index, cursor, false);
      index = cursor;
      codeStart = index;
      continue;
    }
    if (ch === "'") {
      push(codeStart, index, true);
      let j = index + 1;
      while (j < text.length) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      push(index, Math.min(j, text.length), false);
      index = j;
      codeStart = index;
      continue;
    }
    index += 1;
  }
  push(codeStart, text.length, true);
  return segments;
}

export interface IdentifierUsage {
  program: string;
  line: number;
  column: number;
  excerpt: string;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

/** 查找标识符在代码中的使用位置（忽略注释与字符串）。 */
export function findIdentifierUsages(text: string, name: string, program: string): IdentifierUsage[] {
  const usages: IdentifierUsage[] = [];
  const target = name.toLowerCase();
  for (const segment of splitCodeSegments(text)) {
    if (!segment.code) {
      continue;
    }
    const slice = text.slice(segment.start, segment.end);
    IDENTIFIER.lastIndex = 0;
    for (let match = IDENTIFIER.exec(slice); match !== null; match = IDENTIFIER.exec(slice)) {
      if (match[0].toLowerCase() !== target) {
        continue;
      }
      const offset = segment.start + match.index;
      const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
      const lineEnd = text.indexOf('\n', offset);
      usages.push({
        program,
        line: lineOf(text, offset),
        column: offset - lineStart + 1,
        excerpt: text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim().slice(0, 160),
      });
    }
  }
  return usages;
}

/** 在代码段内替换标识符；注释与字符串保持原样。返回替换后的文本与次数。 */
export function replaceIdentifier(text: string, from: string, to: string): { text: string; count: number } {
  const target = from.toLowerCase();
  let result = '';
  let cursor = 0;
  let count = 0;
  for (const segment of splitCodeSegments(text)) {
    result += text.slice(cursor, segment.start);
    if (!segment.code) {
      result += text.slice(segment.start, segment.end);
    } else {
      const slice = text.slice(segment.start, segment.end);
      result += slice.replace(IDENTIFIER, (match) => {
        if (match.toLowerCase() === target) {
          count += 1;
          return to;
        }
        return match;
      });
    }
    cursor = segment.end;
  }
  result += text.slice(cursor);
  return { text: result, count };
}

/**
 * 跳过文件开头的空白、行注释与块注释，返回第一个可能的声明偏移。
 * KLP 的 ST 文件允许注释写在 PROGRAM 之前；只看首行会把这种文件误判为“无文件头”。
 */
export function leadingTriviaEnd(text: string): number {
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    const next = text[index + 1];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\v') {
      index += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', index + 2);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (ch === '(' && next === '*') {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < text.length && depth > 0) {
        if (text[cursor] === '(' && text[cursor + 1] === '*') {
          depth += 1;
          cursor += 2;
          continue;
        }
        if (text[cursor] === '*' && text[cursor + 1] === ')') {
          depth -= 1;
          cursor += 2;
          continue;
        }
        cursor += 1;
      }
      index = cursor;
      continue;
    }
    break;
  }
  return index;
}

export interface ProgramHeaderRange {
  name: string;
  /** PROGRAM 关键字在全文中的偏移。 */
  start: number;
  /** 程序名之后的偏移。 */
  end: number;
}

/** 查找跳过前导注释后的 PROGRAM 头。 */
export function programHeaderRange(text: string): ProgramHeaderRange | undefined {
  const start = leadingTriviaEnd(text);
  const match = /^PROGRAM[ \t]+([A-Za-z_][A-Za-z0-9_]*)/i.exec(text.slice(start));
  if (!match) {
    return undefined;
  }
  const name = match[1] ?? '';
  const nameStart = start + match[0].length - name.length;
  return { name, start, end: nameStart + name.length };
}

/** 改写 ST 文件的 PROGRAM 头。文件头缺失或名称不匹配时返回空字符串表示未命中。 */
export function renameProgramHeader(text: string, from: string, to: string): string {
  const header = programHeaderRange(text);
  if (!header || header.name.toLowerCase() !== from.toLowerCase()) {
    return '';
  }
  return `${text.slice(0, header.start)}PROGRAM ${to}${text.slice(header.end)}`;
}

/** 把 PROGRAM 头设置成 to；没有文件头时在保留前导注释后补一个头。 */
export function setProgramHeaderName(text: string, to: string): string {
  const header = programHeaderRange(text);
  if (header) {
    return `${text.slice(0, header.start)}PROGRAM ${to}${text.slice(header.end)}`;
  }
  const offset = leadingTriviaEnd(text);
  const prefix = text.slice(0, offset);
  const body = text.slice(offset).replace(/^\s+/, '');
  return `${prefix}PROGRAM ${to}\r\n\r\n${body}`;
}

export function programHeaderName(text: string): string | undefined {
  return programHeaderRange(text)?.name;
}

export function defaultProgramTemplate(name: string): string {
  return `PROGRAM ${name}\r\n\r\nEND_PROGRAM\r\n`;
}
