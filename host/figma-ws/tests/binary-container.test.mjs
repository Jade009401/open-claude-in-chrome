// 二进制落盘容器往返:host parseFramesBinary 必须与扩展 __figCaptureGrabToDisk 的写法严格对称。
// 这是修 /figma-ws 240s 卡死(53MB 经通道搬运)后引入的新格式,是扩展↔host 之间唯一的隐式契约。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFramesBinary } from '../ws-design.mjs';

// 镜像扩展 __figCaptureGrabToDisk 的容器写法(host 解析必须与之逐字节对称):
//   [4字节 uint32 LE = 头 JSON 字节长][头 JSON: {url,total,frames:[{len,isSchema}]}][按序拼接的原始帧字节]
function encodeFramesBinary(frames, url = 'https://figma.com/x') {
  const header = JSON.stringify({ url, total: frames.length, frames: frames.map((f) => ({ len: f.bytes.length, isSchema: f.isSchema })) });
  const headerBytes = Buffer.from(header, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(headerBytes.length, 0);
  return Buffer.concat([lenBuf, headerBytes, ...frames.map((f) => Buffer.from(f.bytes))]);
}

test('parseFramesBinary:容器往返 —— 帧顺序/isSchema/字节逐一还原', () => {
  const input = [
    { isSchema: true, bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) },
    { isSchema: false, bytes: new Uint8Array([0xff, 0x00, 0xab, 0xcd]) },
    { isSchema: false, bytes: new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256)) },
  ];
  const out = parseFramesBinary(encodeFramesBinary(input));
  assert.equal(out.length, input.length);
  out.forEach((f, i) => {
    assert.equal(f.isSchema, input[i].isSchema);
    assert.deepEqual([...f.bytes], [...input[i].bytes]);
  });
});

test('parseFramesBinary:文件截断 → 人话报错,不静默产出错帧', () => {
  const input = [
    { isSchema: true, bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) },
    { isSchema: false, bytes: new Uint8Array([9, 9, 9, 9]) },
  ];
  const full = encodeFramesBinary(input);
  assert.throws(() => parseFramesBinary(full.subarray(0, full.length - 2)), /字节不足|截断/);
});

test('parseFramesBinary:空文件/头长度非法 → 报错', () => {
  assert.throws(() => parseFramesBinary(Buffer.alloc(2)), /过短|空/);
  const bad = Buffer.alloc(8);
  bad.writeUInt32LE(9999, 0); // 头长超过文件长度
  assert.throws(() => parseFramesBinary(bad), /头长度非法/);
});
