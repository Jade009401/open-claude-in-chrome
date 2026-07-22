// WS 抓帧解码:fig-wire schema 帧 → 运行时编译 kiwi 解码器(免 codegen)→ 解数据帧 → nodeChanges。
// 依赖 kiwi-schema(运行时 compileSchema)+ fzstd(zstd 解压)。与 REST 管道(host/figma/)完全独立。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const kiwi = require('kiwi-schema');
const fzstd = require('fzstd');

const isZstd = (b) => b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;
const FIG = [0x66, 0x69, 0x67, 0x2d, 0x77, 0x69, 0x72, 0x65]; // "fig-wire"
function isFigWire(b) {
  if (!b || b.length < 12) return false;
  for (let i = 0; i < 8; i++) if (b[i] !== FIG[i]) return false;
  return true;
}

// frames: [{ isSchema?, bytes: Uint8Array }] → { messageType, nodeChanges }
// schema 帧跳过 "fig-wire"(8)+version(4) 后是 zstd 压缩的 kiwi schema;运行时编译成解码器。
function decodeFrames(frames) {
  const schemaFrame = frames.find((f) => f.isSchema || isFigWire(f.bytes));
  if (!schemaFrame) throw new Error('缺 fig-wire schema 帧(抓帧未含 schema)');
  const schemaBytes = fzstd.decompress(schemaFrame.bytes.subarray(12));
  const compiled = kiwi.compileSchema(kiwi.decodeBinarySchema(schemaBytes));

  // 数据帧按大小降序,取第一个能解出 nodeChanges 的(整份文件的全量帧最大)。
  const dataFrames = frames.filter((f) => f !== schemaFrame).map((f) => f.bytes).sort((a, b) => b.length - a.length);
  for (const raw of dataFrames) {
    const data = isZstd(raw) ? new Uint8Array(fzstd.decompress(raw)) : raw;
    try {
      const msg = compiled.decodeMessage(data);
      if (msg && Array.isArray(msg.nodeChanges) && msg.nodeChanges.length) {
        return { messageType: msg.type, nodeChanges: msg.nodeChanges };
      }
    } catch { /* 换下一帧 */ }
  }
  throw new Error('没有数据帧可解出 nodeChanges');
}

// figma-frames.json 形状:{ frames:[{ len, isSchema, b64 }] }
function decodeBundle(bundle) {
  const frames = (bundle?.frames || []).map((f) => ({ isSchema: f.isSchema, bytes: new Uint8Array(Buffer.from(f.b64, 'base64')) }));
  return decodeFrames(frames);
}

export { decodeFrames, decodeBundle, isFigWire };
