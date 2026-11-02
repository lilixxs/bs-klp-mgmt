import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeText, encodeGbk, EncodingError, toCrlf } from '../src/util/encoding.ts';

test('GBK 解码与编码保持一致', () => {
  const bytes = Uint8Array.from([0xd0, 0xc4, 0xcc, 0xf8, 0xce, 0xbb]);
  const decoded = decodeText(bytes);
  assert.equal(decoded.text, '心跳位');
  assert.equal(decoded.encoding, 'gbk');
  assert.deepEqual(encodeGbk(decoded.text), bytes);
});

test('ASCII 文本按 UTF-8 处理且字节不变', () => {
  const bytes = new TextEncoder().encode('PROGRAM MAIN\r\nEND_PROGRAM\r\n');
  const decoded = decodeText(bytes);
  assert.equal(decoded.encoding, 'utf-8');
  assert.equal(decoded.text, 'PROGRAM MAIN\r\nEND_PROGRAM\r\n');
  assert.deepEqual(new TextEncoder().encode(decoded.text), bytes);
});

test('无法用 GBK 表示的字符必须报错而不是替换', () => {
  assert.throws(() => encodeGbk('温度😀'), EncodingError);
});

test('换行统一为 CRLF', () => {
  assert.equal(toCrlf('a\nb\r\nc\rd'), 'a\r\nb\r\nc\r\nd');
});
