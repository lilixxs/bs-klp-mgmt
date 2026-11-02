/** 文本编码：KLP 的 .stf 与部分 INI 使用 GBK（代码页 936）。Node 只内置 GBK 解码，这里补齐编码。 */

const GBK = 'gbk';

let gbkEncodeTable: Map<number, number> | undefined;

/** 由内置解码器反推 GBK 双字节编码表（一次构建，约 2.3 万次解码）。 */
function getGbkEncodeTable(): Map<number, number> {
  if (gbkEncodeTable) {
    return gbkEncodeTable;
  }
  const decoder = new TextDecoder(GBK);
  const table = new Map<number, number>();
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) {
        continue;
      }
      const text = decoder.decode(Uint8Array.of(lead, trail));
      if (text.length !== 1) {
        continue;
      }
      const codePoint = text.codePointAt(0);
      if (codePoint === undefined || codePoint === 0xfffd) {
        continue;
      }
      if (!table.has(codePoint)) {
        table.set(codePoint, (lead << 8) | trail);
      }
    }
  }
  gbkEncodeTable = table;
  return table;
}

export interface DecodedText {
  text: string;
  encoding: 'gbk' | 'utf-8';
  /** 是否含无效字节（解码器替换为 U+FFFD）。 */
  lossy: boolean;
}

/** 读取文本：优先按 GBK，失败或含替换字符时回退 UTF-8，并给出可用编码。 */
export function decodeText(bytes: Uint8Array): DecodedText {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = new TextDecoder('utf-8').decode(bytes.subarray(3));
    return { text, encoding: 'utf-8', lossy: text.includes('\uFFFD') };
  }
  const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
  const gbkDecoder = new TextDecoder(GBK, { fatal: false });
  const gbkText = gbkDecoder.decode(bytes);
  const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
  try {
    const utf8Text = strictUtf8.decode(bytes);
    // 纯 ASCII 或合法 UTF-8：两者等价，按 UTF-8 处理更稳妥。
    if (!gbkText.includes('\uFFFD') || utf8Text === gbkText) {
      return { text: utf8Text, encoding: 'utf-8', lossy: false };
    }
    return { text: utf8Text, encoding: 'utf-8', lossy: false };
  } catch {
    return { text: gbkText, encoding: 'gbk', lossy: gbkText.includes('\uFFFD') };
  }
  // 不可达，保留以便阅读分支结构。
  return { text: utf8Decoder.decode(bytes), encoding: 'utf-8', lossy: true };
}

export class EncodingError extends Error {
  readonly character: string;
  readonly index: number;

  constructor(message: string, character: string, index: number) {
    super(message);
    this.name = 'EncodingError';
    this.character = character;
    this.index = index;
  }
}

/** 按 GBK 编码；遇到无法表示的字符直接报错，绝不静默替换。 */
export function encodeGbk(text: string): Uint8Array {
  const table = getGbkEncodeTable();
  const out: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint < 0x80) {
      out.push(codePoint);
      continue;
    }
    const encoded = table.get(codePoint);
    if (encoded === undefined) {
      throw new EncodingError(
        `字符 “${String.fromCodePoint(codePoint)}” 无法用 GBK 表示（位置 ${index}）。`,
        String.fromCodePoint(codePoint),
        index,
      );
    }
    out.push(encoded >> 8, encoded & 0xff);
    if (codePoint > 0xffff) {
      index += 1;
    }
  }
  return Uint8Array.from(out);
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** KLP .stf：除 UTF-8 BOM 外一律按 GBK 解释（避免把混合编码误判为 UTF-8）。 */
export function decodeStBytes(bytes: Uint8Array): DecodedText {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = new TextDecoder('utf-8').decode(bytes.subarray(3));
    return { text, encoding: 'utf-8', lossy: text.includes('\uFFFD') };
  }
  const text = new TextDecoder(GBK).decode(bytes);
  return { text, encoding: 'gbk', lossy: text.includes('\uFFFD') };
}

export function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

export function encodeText(text: string, encoding: 'gbk' | 'utf-8'): Uint8Array {
  return encoding === 'gbk' ? encodeGbk(text) : encodeUtf8(text);
}

/** 按原文件编码写回文本；原文件带 UTF-8 BOM 时保留 BOM。 */
export function encodeTextLike(original: Uint8Array | undefined, text: string): Uint8Array {
  if (original && hasUtf8Bom(original)) {
    const body = encodeUtf8(text);
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf], 0);
    out.set(body, 3);
    return out;
  }
  return encodeGbk(text);
}

/**
 * `klp-st:` 文件系统对编辑器呈现的字节。
 * VSCode 按 `[klp-st] files.encoding=gbk` 解码，因此统一返回 GBK 表示；
 * 原文件若是 UTF-8 BOM，写入时再由 encodeStFromEditor 还原，避免 BOM 丢失。
 */
export function stBytesForEditor(bytes: Uint8Array): Uint8Array {
  const decoded = decodeStBytes(bytes);
  try {
    return encodeGbk(toCrlf(decoded.text));
  } catch {
    // 读路径不能因为原文含 GBK 无法表示的字符就让文件打不开；写路径仍会在保存时拒绝。
    return bytes;
  }
}

/** 把编辑器内容写回磁盘；保留目标文件原有的 UTF-8 BOM 编码。 */
export function stBytesFromEditor(content: Uint8Array, existing: Uint8Array | undefined): Uint8Array {
  const hasBom = hasUtf8Bom(content);
  const text = hasBom ? new TextDecoder('utf-8').decode(content.subarray(3)) : new TextDecoder(GBK).decode(content);
  return encodeTextLike(existing, toCrlf(text));
}

/** 统一换行：KLP 文本文件使用 CRLF。 */
export function toCrlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\r\n');
}
