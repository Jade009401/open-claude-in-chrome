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

export { designFromNodeChanges, readWsDesignFromBundle, readWsDesignFromFrames, countNodes };
