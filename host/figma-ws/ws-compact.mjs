// WS 场景图节点 → 压缩结构化摘要(与 REST compactDesign 输出同一 shape,好复用 prompt-gen 的 walkSpec/buildLoadContext)。
// 重点=去噪(用户要求"数据不要有太多噪声"):矢量/布尔→icon 叶、隐藏/零尺寸/slice 丢、组件实例不下钻、
// 相邻同款结构折叠成示样×N、小图标容器折成 icon 叶。纯函数,自带 4 个小工具,不依赖 host/figma/(保持管道独立)。
import { gkey } from './scope.mjs';

function rgbaHex(c) {
  if (!c) return null;
  const to = (v) => Math.round((v ?? 0) * 255).toString(16).padStart(2, '0');
  const hex = `#${to(c.r)}${to(c.g)}${to(c.b)}`;
  return c.a != null && c.a < 1 ? `${hex}@${Number(c.a).toFixed(2)}` : hex;
}
function firstSolid(paints) {
  const f = (paints || []).find((p) => p.type === 'SOLID' && p.visible !== false);
  return f ? rgbaHex(f.color) : null;
}
// 结构签名(忽略 name/text/坐标,只看 type+尺寸+组件+子结构)→ 折叠同款重复
function structuralSig(n) {
  const b = n.box ? `${n.box.w}x${n.box.h}` : '';
  const kids = (n.children || []).map(structuralSig).join(',');
  return `${n.type}#${b}#${n.component || ''}[${kids}]`;
}
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

const ICON_LEAF = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'LINE', 'REGULAR_POLYGON', 'STAR']);
const SKIP = new Set(['SLICE']);

// 成组"装饰叶"折叠:同类型的纯色形状叶子(无文案/无子/非组件/非图片),一组 ≥5 个 → 折成一条 ×N。
// 治订单簿深度条这类"数据驱动、变宽、非相邻"的重复矩形(collapseRepeats 只并相邻同签名,治不了)。
const DECOR = new Set(['RECTANGLE', 'ROUNDED_RECTANGLE', 'ELLIPSE']);
const isDecorLeaf = (n) => DECOR.has(n.type) && !n.text && !n.component && !n.image && !(n.children && n.children.length);
function collapseDecoration(kids, threshold = 5) {
  const byType = new Map();
  for (const k of kids) if (isDecorLeaf(k)) (byType.get(k.type) || byType.set(k.type, []).get(k.type)).push(k);
  const heavy = [...byType.values()].filter((g) => g.length >= threshold);
  if (!heavy.length) return kids;
  const collapsed = new Set(heavy.flat());
  const out = kids.filter((k) => !collapsed.has(k));
  for (const g of heavy) {
    const rep = { ...g[0] };
    delete rep.__sig;
    rep.name = `${g[0].name || '装饰块'}(装饰)`;
    rep.repeat = g.reduce((s, d) => s + (d.repeat || 1), 0);
    out.push(rep);
  }
  return out;
}

// box 来自 transform(m02/m12 已是父坐标系内的相对位移)+ size,比 REST 的绝对框相减更直接。
function boxOf(n) {
  const t = n.transform || {};
  const s = n.size || {};
  return { x: Math.round(t.m02 || 0), y: Math.round(t.m12 || 0), w: Math.round(s.x || 0), h: Math.round(s.y || 0) };
}

// 从 rootKey 递归压缩 + 去噪。idx = buildIndex 结果。
function wsCompact(rootKey, idx, { maxDepth = 12 } = {}) {
  const { byGuid, childrenOf, symbols } = idx;
  function walk(k, depth) {
    const n = byGuid.get(k);
    if (!n || n.visible === false || SKIP.has(n.type)) return null;
    if (ICON_LEAF.has(n.type)) return { type: 'ICON', name: n.name }; // 矢量降噪:不下钻路径点
    const box = boxOf(n);
    const out = { type: n.type, name: n.name, box }; // C:零尺寸判定移到"查完子"之后(见末尾)

    if (n.type === 'TEXT') {
      out.text = n.textData?.characters || '';
      if (n.fontSize) out.font = { size: Math.round(n.fontSize), weight: n.fontName?.style || null };
      const col = firstSolid(n.fillPaints);
      if (col) out.color = col;
      return out;
    }
    if ((n.fillPaints || []).some((p) => p.type === 'IMAGE' && p.visible !== false)) out.image = true; // WS 只有 hash 无 URL,仅标记
    const fill = firstSolid(n.fillPaints);
    if (fill) out.fill = fill;
    // D:圆角 —— 优先统一 cornerRadius;否则读逐角(CSS 序 tl/tr/br/bl)。缺角默认 0;统一出单值,不等出 "tl/tr/br/bl"。
    if (n.cornerRadius) {
      out.radius = Math.round(n.cornerRadius);
    } else {
      const cs = [n.rectangleTopLeftCornerRadius, n.rectangleTopRightCornerRadius, n.rectangleBottomRightCornerRadius, n.rectangleBottomLeftCornerRadius].map((v) => Math.round(v || 0));
      if (cs.some((v) => v > 0)) out.radius = cs.every((v) => v === cs[0]) ? cs[0] : cs.join('/');
    }
    if (n.stackMode && n.stackMode !== 'NONE') {
      out.layout = {
        dir: n.stackMode === 'HORIZONTAL' ? 'row' : 'col',
        gap: n.stackSpacing ?? 0,
        // [上,右,下,左]:Figma stackVerticalPadding=上, stackPaddingBottom=下, stackHorizontalPadding=左, stackPaddingRight=右
        pad: [n.stackVerticalPadding ?? 0, n.stackPaddingRight ?? 0, n.stackPaddingBottom ?? 0, n.stackHorizontalPadding ?? 0],
        align: n.stackCounterAlignItems || null,
      };
    }
    if (n.type === 'INSTANCE') { // 组件实例:只留引用名,不钻内部零件(去噪 + 映射线索)
      const sid = n.symbolData && gkey(n.symbolData.symbolID);
      out.component = (sid && symbols.get(sid)) || n.name;
      return out;
    }
    if (depth < maxDepth) {
      const kids = (childrenOf.get(k) || []).map((c) => walk(gkey(c.guid), depth + 1)).filter(Boolean);
      if (kids.length) out.children = collapseDecoration(collapseRepeats(kids)); // 先并相邻同款,再折成组装饰叶
    }
    // 小容器(≤48)+ 无文本 + 子全是 icon → 折成 icon 叶(去掉图标内部噪音)
    if (box.w <= 48 && box.h <= 48 && !out.text && out.children && out.children.length && out.children.every((c) => c.type === 'ICON')) {
      return { type: 'ICON', name: out.name, box };
    }
    // C:零尺寸容器且无有效子 → 丢(不可见);有子的零尺寸容器保留(如 375×0 裹着分隔线的组)
    if ((box.w < 1 || box.h < 1) && !(out.children && out.children.length)) return null;
    return out;
  }
  return walk(rootKey, 0);
}

export { wsCompact, structuralSig, collapseRepeats, rgbaHex };
