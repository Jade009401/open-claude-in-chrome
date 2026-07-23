// WS 设计管道编排(独立于 REST):抓帧/nodeChanges → 按 node-id 抽子树 → 去噪压缩 → 出 { design, palette, componentList }。
import { decodeBundle, decodeFrames } from './kiwi-decode.mjs';
import { buildIndex, nodeIdToKey } from './scope.mjs';
import { wsCompact } from './ws-compact.mjs';

function countNodes(d) {
  if (!d) return 0;
  return 1 + (d.children || []).reduce((s, c) => s + countNodes(c), 0);
}
function collectPalette(d, set = new Set()) {
  if (!d) return set;
  if (d.fill) set.add(d.fill);
  if (d.color) set.add(d.color);
  (d.children || []).forEach((c) => collectPalette(c, set));
  return set;
}
function collectComponents(d, set = new Set()) {
  if (!d) return set;
  if (d.component) set.add(d.component);
  (d.children || []).forEach((c) => collectComponents(c, set));
  return set;
}

// nodeChanges(全量)+ node-id → 该屏压缩设计。node-id 未命中抛错(交调用方人话)。
function designFromNodeChanges(nodeChanges, nodeId) {
  const idx = buildIndex(nodeChanges);
  const rootKey = nodeIdToKey(nodeId);
  if (!idx.byGuid.has(rootKey)) throw new Error(`node-id「${nodeId}」未在场景图命中(是否选中了具体那一屏?)`);
  const design = wsCompact(rootKey, idx);
  if (!design) throw new Error(`node-id「${nodeId}」子树为空(可能整屏隐藏)`);
  return {
    rootKey,
    design,
    palette: [...collectPalette(design)],
    componentList: [...collectComponents(design)],
    nodeCount: countNodes(design),
  };
}

// figma-frames.json bundle → 设计(CLI/验证用)
function readWsDesignFromBundle(bundle, nodeId) {
  const { nodeChanges } = decodeBundle(bundle);
  return designFromNodeChanges(nodeChanges, nodeId);
}
// 扩展直传的 frames([{isSchema,bytes}]) → 设计(生产管道用)
function readWsDesignFromFrames(frames, nodeId) {
  const { nodeChanges } = decodeFrames(frames);
  return designFromNodeChanges(nodeChanges, nodeId);
}

// 二进制落盘容器 → frames。与扩展 __figCaptureGrabToDisk 的写法严格对称:
//   [4字节 uint32 LE = 头 JSON 字节长][头 JSON: {frames:[{len,isSchema}]}][按序拼接的原始帧字节]
function parseFramesBinary(buf) {
  if (!buf || buf.length < 4) throw new Error('帧文件为空或过短(落盘失败?)');
  const headerLen = buf.readUInt32LE(0);
  const headerEnd = 4 + headerLen;
  if (headerLen <= 0 || headerEnd > buf.length) throw new Error('帧文件头长度非法(文件损坏/未写完)');
  let header;
  try { header = JSON.parse(buf.subarray(4, headerEnd).toString('utf8')); }
  catch { throw new Error('帧文件头 JSON 解析失败(文件损坏)'); }
  const metas = Array.isArray(header?.frames) ? header.frames : [];
  const frames = [];
  let off = headerEnd;
  for (const m of metas) {
    const len = Number(m?.len) || 0;
    const end = off + len;
    if (end > buf.length) throw new Error('帧文件字节不足(与头声明不符,文件截断)');
    frames.push({ isSchema: Boolean(m?.isSchema), bytes: buf.subarray(off, end) }); // Buffer 是 Uint8Array 子类,可直接喂 decodeFrames
    off = end;
  }
  if (!frames.length) throw new Error('帧文件未含任何帧');
  return frames;
}
// 二进制落盘文件内容(Buffer) + node-id → 设计(生产管道用,替代经通道搬 base64 bundle)
function readWsDesignFromBinary(buf, nodeId) {
  return readWsDesignFromFrames(parseFramesBinary(buf), nodeId);
}

export { designFromNodeChanges, readWsDesignFromBundle, readWsDesignFromFrames, readWsDesignFromBinary, parseFramesBinary, countNodes };
