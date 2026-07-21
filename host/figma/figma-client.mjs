// Figma REST 适配器:读节点子树 + host 侧压缩(只把精简结构化摘要喂模型,原始 JSON 不进上下文)。
// 走官方 REST(个人 token 或组织 Plan Access Token),不走 MCP(免限流/付费),不请求 geometry(矢量点默认不返回)。
// 压缩(参 Pure Map "完整地图不进上下文"):相对坐标 + 组件去重 + 文本主导样式 + 限深 +
//   结构相似折叠(大列表→示样1条×N)+ 矢量/图标降噪 + 调色板汇总 + 图片渲染 URL。
import { assertFigmaToken, figmaToken } from './config.mjs';

const API_BASE = 'https://api.figma.com/v1';

// 从 figma 链接抽 { fileKey, nodeId }。分享链接 node-id 用 '-',API 用 ':'。
function parseFigmaUrl(input) {
  const raw = String(input || '');
  const fileKey = (raw.match(/\/(?:file|design)\/([A-Za-z0-9]+)/) || [])[1] || null;
  const nodeRaw = (raw.match(/[?&]node-id=([^&]+)/) || [])[1] || null;
  const nodeId = nodeRaw ? decodeURIComponent(nodeRaw).replace(/-/g, ':') : null;
  return { fileKey, nodeId };
}

// 拉节点子树。返回 { node, components, styles }。不带 geometry(默认即不含矢量点)。
async function readNode(fileKey, nodeId) {
  assertFigmaToken();
  if (!fileKey || !nodeId) throw new Error(`Figma 链接解析失败(fileKey=${fileKey} nodeId=${nodeId})`);
  const url = `${API_BASE}/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`;
  const r = await fetch(url, { headers: { 'X-Figma-Token': figmaToken } });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Figma API ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = await r.json();
  const entry = data?.nodes?.[nodeId];
  if (!entry?.document) throw new Error(`节点 ${nodeId} 未返回(检查 node-id 与文件访问权限)`);
  return { node: entry.document, components: entry.components || {}, styles: entry.styles || {} };
}

// —— 压缩纯函数 ——
function rgbaHex(c) {
  if (!c) return null;
  const to = (v) => Math.round((v ?? 0) * 255).toString(16).padStart(2, '0');
  const hex = `#${to(c.r)}${to(c.g)}${to(c.b)}`;
  return c.a != null && c.a < 1 ? `${hex}@${Number(c.a).toFixed(2)}` : hex;
}
function firstSolidFill(node) {
  const f = (node?.fills || []).find((x) => x.type === 'SOLID' && x.visible !== false);
  return f ? rgbaHex(f.color) : null;
}
function relBox(abs, parentAbs) {
  if (!abs) return null;
  const x = parentAbs ? abs.x - parentAbs.x : abs.x;
  const y = parentAbs ? abs.y - parentAbs.y : abs.y;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(abs.width), h: Math.round(abs.height) };
}

// 结构签名:只看 type + 尺寸 + 组件 + 子结构,忽略 name/text/坐标 → 用于"结构相似折叠"。
function structuralSig(n) {
  const box = n.box ? `${n.box.w}x${n.box.h}` : '';
  const kids = (n.children || []).map(structuralSig).join(',');
  return `${n.type}#${box}#${n.component || ''}[${kids}]`;
}
// 相邻"结构相同"的兄弟折叠成一条(保留首条作示样)+ repeat 计数 —— 治大列表(行情 11 行等)。
function collapseRepeats(kids) {
  const out = [];
  for (const k of kids) {
    const s = structuralSig(k);
    const prev = out[out.length - 1];
    if (prev && prev.__sig === s) { prev.repeat = (prev.repeat || 1) + 1; continue; }
    k.__sig = s;
    out.push(k);
  }
  for (const o of out) delete o.__sig;
  return out;
}

const ICON_LEAF_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION']);
const isIconLeaf = (n) => n && n.type === 'ICON';

// 把 Figma 节点树压缩成精简结构化摘要。降噪:纯矢量→icon 叶;小图标容器→icon 叶。
function compactDesign(root, { components = {}, maxDepth = 8 } = {}) {
  const compName = (id) => components[id]?.name || null;
  function walk(node, depth, parentAbs) {
    if (!node || node.visible === false) return null;
    if (ICON_LEAF_TYPES.has(node.type)) return { type: 'ICON', name: node.name }; // 矢量降噪:不下钻
    const abs = node.absoluteBoundingBox;
    const out = { type: node.type, name: node.name };
    const box = relBox(abs, parentAbs);
    if (box) out.box = box;

    if (node.type === 'TEXT' && typeof node.characters === 'string') {
      out.text = node.characters;
      const st = node.style || {};
      if (st.fontSize) out.font = { size: Math.round(st.fontSize), weight: st.fontWeight || null };
      const col = firstSolidFill(node);
      if (col) out.color = col;
      return out;
    }
    // 图片填充 → 标记 + 留 id(供 /v1/images 取渲染图)
    if ((node.fills || []).some((f) => f.type === 'IMAGE' && f.visible !== false)) {
      out.image = true;
      out.id = node.id;
    }
    const fill = firstSolidFill(node);
    if (fill) out.fill = fill;
    if (node.cornerRadius) out.radius = Math.round(node.cornerRadius);
    if (node.layoutMode && node.layoutMode !== 'NONE') {
      out.layout = {
        dir: node.layoutMode === 'HORIZONTAL' ? 'row' : 'col',
        gap: node.itemSpacing ?? 0,
        pad: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map((v) => v ?? 0),
        align: node.primaryAxisAlignItems || null,
      };
    }
    if (node.type === 'INSTANCE') { out.component = compName(node.componentId) || node.name; return out; }
    if (Array.isArray(node.children) && depth < maxDepth) {
      const kids = node.children.map((c) => walk(c, depth + 1, abs)).filter(Boolean);
      if (kids.length) out.children = collapseRepeats(kids);
    }
    // 小容器(≤48)+ 无文本 + 子全是 icon → 折成 icon 叶(去掉图标内部噪音)
    if (out.box && out.box.w <= 48 && out.box.h <= 48 && !out.text
      && out.children && out.children.length && out.children.every(isIconLeaf)) {
      return { type: 'ICON', name: out.name, box: out.box };
    }
    return out;
  }
  return walk(root, 0, null);
}

// —— 遍历压缩树:调色板 / 图片 id / 回填图片 URL ——
function collectPalette(node, set = new Set()) {
  if (!node) return set;
  if (node.fill) set.add(node.fill);
  if (node.color) set.add(node.color);
  (node.children || []).forEach((c) => collectPalette(c, set));
  return set;
}
function collectImageIds(node, ids = []) {
  if (!node) return ids;
  if (node.image && node.id) ids.push(node.id);
  (node.children || []).forEach((c) => collectImageIds(c, ids));
  return ids;
}
function attachImageUrls(node, map) {
  if (!node) return;
  if (node.image && node.id && map[node.id]) node.imageUrl = map[node.id];
  (node.children || []).forEach((c) => attachImageUrls(c, map));
}
async function fetchImages(fileKey, ids) {
  if (!ids.length) return {};
  assertFigmaToken();
  const url = `${API_BASE}/images/${encodeURIComponent(fileKey)}?ids=${ids.map(encodeURIComponent).join(',')}&format=png&scale=1`;
  const r = await fetch(url, { headers: { 'X-Figma-Token': figmaToken } });
  if (!r.ok) return {};
  const data = await r.json().catch(() => ({}));
  return data?.images || {};
}

// 便捷:URL → { fileKey, nodeId, componentList, palette, design }。withImages 时取节点渲染图 URL。
async function readDesign(url, { withImages = true } = {}) {
  const { fileKey, nodeId } = parseFigmaUrl(url);
  const { node, components } = await readNode(fileKey, nodeId);
  const design = compactDesign(node, { components });
  const palette = [...collectPalette(design)];
  if (withImages) {
    const ids = collectImageIds(design);
    if (ids.length) { try { attachImageUrls(design, await fetchImages(fileKey, ids)); } catch { /* 图片可选,失败忽略 */ } }
  }
  const componentList = [...new Set(Object.values(components).map((c) => c.name).filter(Boolean))];
  return { fileKey, nodeId, componentList, palette, design };
}

export { parseFigmaUrl, readNode, compactDesign, collectPalette, structuralSig, readDesign };
