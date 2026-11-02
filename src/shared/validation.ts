/** 名称与字段校验。扩展与 webview 共用，不依赖 vscode/DOM。 */

export const IDENTIFIER_MAX = 128;

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** ST / IEC 61131-3 保留字（用于避免生成无法编译的标识符）。 */
const RESERVED = new Set(
  [
    'PROGRAM',
    'END_PROGRAM',
    'FUNCTION',
    'END_FUNCTION',
    'FUNCTION_BLOCK',
    'END_FUNCTION_BLOCK',
    'VAR',
    'VAR_INPUT',
    'VAR_OUTPUT',
    'VAR_IN_OUT',
    'VAR_GLOBAL',
    'VAR_TEMP',
    'END_VAR',
    'IF',
    'THEN',
    'ELSE',
    'ELSIF',
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
    'AND',
    'OR',
    'XOR',
    'NOT',
    'MOD',
    'TRUE',
    'FALSE',
  ].map((word) => word.toUpperCase()),
);

export interface FieldIssue {
  code: string;
  message: string;
}

export function validateIdentifier(raw: string, label = '名称'): FieldIssue | undefined {
  const name = raw.trim();
  if (!name) {
    return { code: 'name.empty', message: `${label}不能为空。` };
  }
  if (name.length > IDENTIFIER_MAX) {
    return { code: 'name.tooLong', message: `${label}不能超过 ${IDENTIFIER_MAX} 个字符。` };
  }
  if (!IDENTIFIER_PATTERN.test(name)) {
    return {
      code: 'name.syntax',
      message: `${label}必须以字母或下划线开头，且只能包含字母、数字和下划线。`,
    };
  }
  if (RESERVED.has(name.toUpperCase())) {
    return { code: 'name.reserved', message: `${label}“${name}”是 ST 保留字，不能使用。` };
  }
  return undefined;
}

export function validateFreeTextName(raw: string, label = '名称', maxLength = 64): FieldIssue | undefined {
  const name = raw.trim();
  if (!name) {
    return { code: 'name.empty', message: `${label}不能为空。` };
  }
  if (name.length > maxLength) {
    return { code: 'name.tooLong', message: `${label}不能超过 ${maxLength} 个字符。` };
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return { code: 'name.control', message: `${label}不能包含控制字符。` };
  }
  return undefined;
}

const WINDOWS_INVALID = /[\\/:*?"<>|]/;

export function validateProjectName(raw: string): FieldIssue | undefined {
  const name = raw.trim();
  if (!name) {
    return { code: 'projectName.empty', message: '工程名不能为空。' };
  }
  if (name.length > 128) {
    return { code: 'projectName.tooLong', message: '工程名不能超过 128 个字符。' };
  }
  if (WINDOWS_INVALID.test(name)) {
    return { code: 'projectName.invalidChars', message: '工程名不能包含 \\ / : * ? " < > |。' };
  }
  if (name === '.' || name === '..' || /[. ]$/.test(name)) {
    return { code: 'projectName.invalidEnd', message: '工程名不能以空格或句点结尾，也不能是 . 或 ..。' };
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return { code: 'projectName.control', message: '工程名不能包含控制字符。' };
  }
  return undefined;
}

export function isIdentifier(raw: string): boolean {
  return IDENTIFIER_PATTERN.test(raw);
}
