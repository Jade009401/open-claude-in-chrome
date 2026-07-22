// WS 设计管道纯逻辑单测:按 node-id 抽子树 + 去噪 + 归一化(合成 nodeChanges,不打真接口/不读抓包)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { designFromNodeChanges } from '../ws-design.mjs';
import { buildIndex, nodeIdToKey } from '../scope.mjs';

// —— 合成一份小场景图 ——
const ROOT = { sessionID: 3, localID: 100 };
const pi = (pos) => ({ guid: ROOT, position: pos });
const xf = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const nodeChanges = [
  { guid: { sessionID: 9, localID: 1 }, type: 'SYMBOL', name: 'PrimaryButton' }, // 组件主(在别处)
  { guid: ROOT, type: 'FRAME', name: '活动页', visible: true, transform: xf(0, 0), size: { x: 375, y: 800 },
    fillPaints: [{ type: 'SOLID', visible: true, color: { r: 1, g: 1, b: 1, a: 1 } }] },
  { guid: { sessionID: 3, localID: 101 }, type: 'TEXT', name: '标题', visible: true, parentIndex: pi('a'),
    transform: xf(16, 16), size: { x: 200, y: 30 }, textData: { characters: 'TradFi 活动' },
    fontSize: 20, fontName: { family: 'Inter', style: 'Bold' },
    fillPaints: [{ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0, a: 1 } }] },
  { guid: { sessionID: 3, localID: 102 }, type: 'VECTOR', name: 'arrow', visible: true, parentIndex: pi('b'),
    transform: xf(0, 0), size: { x: 12, y: 12 } }, // → ICON 叶
  { guid: { sessionID: 3, localID: 103 }, type: 'FRAME', name: '隐藏块', visible: false, parentIndex: pi('c'),
    transform: xf(0, 0), size: { x: 50, y: 50 } }, // 隐藏 → 丢
  { guid: { sessionID: 3, localID: 104 }, type: 'INSTANCE', name: '按钮实例', visible: true, parentIndex: pi('d'),
    transform: xf(16, 60), size: { x: 343, y: 44 }, symbolData: { symbolID: { sessionID: 9, localID: 1 } } },
  { guid: { sessionID: 3, localID: 105 }, type: 'RECTANGLE', name: '零尺寸', visible: true, parentIndex: pi('e'),
    transform: xf(0, 0), size: { x: 0, y: 0 } }, // 零尺寸 → 丢
  { guid: { sessionID: 3, localID: 106 }, type: 'FRAME', name: '行', visible: true, parentIndex: pi('f'),
    transform: xf(0, 120), size: { x: 375, y: 40 }, stackMode: 'HORIZONTAL', stackSpacing: 12,
    stackVerticalPadding: 8, stackPaddingRight: 16, stackPaddingBottom: 8, stackHorizontalPadding: 16, stackCounterAlignItems: 'CENTER' },
  // 6 个装饰矩形(变宽)→ 折成一条
  ...Array.from({ length: 6 }, (_, i) => ({
    guid: { sessionID: 3, localID: 200 + i }, type: 'ROUNDED_RECTANGLE', name: 'bar', visible: true, parentIndex: pi('g' + i),
    transform: xf(0, 200 + i * 10), size: { x: 20 + i, y: 10 }, cornerRadius: 2,
    fillPaints: [{ type: 'SOLID', visible: true, color: { r: 0, g: 0.7, b: 0.4, a: 1 } }],
  })),
  // 子树外的节点(父=别的 canvas)→ 绝不能出现
  { guid: { sessionID: 5, localID: 500 }, type: 'TEXT', name: '别的页', visible: true,
    parentIndex: { guid: { sessionID: 5, localID: 1 }, position: 'a' }, transform: xf(0, 0), size: { x: 10, y: 10 },
    textData: { characters: '不该出现' } },
];

test('scope:node-id 横杠→冒号键;buildIndex 建 guid/children/symbols', () => {
  assert.equal(nodeIdToKey('3-100'), '3:100');
  const idx = buildIndex(nodeChanges);
  assert.ok(idx.byGuid.has('3:100'));
  assert.equal(idx.symbols.get('9:1'), 'PrimaryButton');
  assert.equal((idx.childrenOf.get('3:100') || []).length, 12); // 6 固定 + 6 装饰(去噪前的原始子)
});

test('designFromNodeChanges:只切选中那屏子树 + 去噪 + 归一化', () => {
  const { design, palette, componentList } = designFromNodeChanges(nodeChanges, '3-100');
  assert.equal(design.type, 'FRAME');
  assert.equal(design.name, '活动页');
  assert.equal(design.fill, '#ffffff');
  const kids = design.children;

  // 文本:内容/字号/字重(style)/颜色/相对 box(来自 transform)
  const t = kids.find((k) => k.type === 'TEXT');
  assert.equal(t.text, 'TradFi 活动');
  assert.deepEqual(t.font, { size: 20, weight: 'Bold' });
  assert.equal(t.color, '#000000');
  assert.deepEqual(t.box, { x: 16, y: 16, w: 200, h: 30 });

  // 矢量 → ICON 叶
  assert.ok(kids.some((k) => k.type === 'ICON' && k.name === 'arrow'));
  // 隐藏 / 零尺寸 → 丢
  assert.ok(!kids.some((k) => k.name === '隐藏块'));
  assert.ok(!kids.some((k) => k.name === '零尺寸'));
  // INSTANCE → 组件名解引用
  const inst = kids.find((k) => k.type === 'INSTANCE');
  assert.equal(inst.component, 'PrimaryButton');
  assert.ok(componentList.includes('PrimaryButton'));
  // auto-layout
  const row = kids.find((k) => k.name === '行');
  assert.deepEqual(row.layout, { dir: 'row', gap: 12, pad: [8, 16, 8, 16], align: 'CENTER' });
  // 装饰矩形成组折叠(一条 repeat=6)
  const decor = kids.find((k) => /装饰/.test(k.name || ''));
  assert.ok(decor, '应有折叠后的装饰条');
  assert.equal(decor.repeat, 6);
  // 调色板非空且含根底色
  assert.ok(palette.includes('#ffffff'));
});

test('子树外节点绝不出现(scoping 生效)', () => {
  const { design } = designFromNodeChanges(nodeChanges, '3-100');
  const json = JSON.stringify(design);
  assert.ok(!json.includes('不该出现'));
  assert.ok(!json.includes('别的页'));
});

test('node-id 未命中 → 抛人话错误', () => {
  assert.throws(() => designFromNodeChanges(nodeChanges, '9-999'), /未在场景图命中/);
});

// —— C(零尺寸判定后移)+ D(逐角圆角)专用 fixture ——
const R2 = { sessionID: 7, localID: 1 };
const pi2 = (pos) => ({ guid: R2, position: pos });
const cornerNodes = [
  { guid: R2, type: 'FRAME', name: '根', visible: true, transform: xf(0, 0), size: { x: 400, y: 400 } },
  // 逐角不等 → "8/8/0/0"(tl/tr/br/bl)。尺寸各异,避免被 collapseRepeats 同款折叠。
  { guid: { sessionID: 7, localID: 2 }, type: 'ROUNDED_RECTANGLE', name: '上圆角卡', visible: true, parentIndex: pi2('a'),
    transform: xf(0, 0), size: { x: 100, y: 40 },
    rectangleTopLeftCornerRadius: 8, rectangleTopRightCornerRadius: 8, rectangleBottomRightCornerRadius: 0, rectangleBottomLeftCornerRadius: 0 },
  // 逐角相等 → 单值 6
  { guid: { sessionID: 7, localID: 3 }, type: 'ROUNDED_RECTANGLE', name: '四角同', visible: true, parentIndex: pi2('b'),
    transform: xf(0, 50), size: { x: 120, y: 40 },
    rectangleTopLeftCornerRadius: 6, rectangleTopRightCornerRadius: 6, rectangleBottomRightCornerRadius: 6, rectangleBottomLeftCornerRadius: 6 },
  // 统一 cornerRadius → 单值 12
  { guid: { sessionID: 7, localID: 4 }, type: 'ROUNDED_RECTANGLE', name: '统一角', visible: true, parentIndex: pi2('c'),
    transform: xf(0, 100), size: { x: 140, y: 40 }, cornerRadius: 12 },
  // 零尺寸容器但有可见文本子 → 整棵保留
  { guid: { sessionID: 7, localID: 5 }, type: 'FRAME', name: '零尺寸有子', visible: true, parentIndex: pi2('d'),
    transform: xf(0, 150), size: { x: 375, y: 0 } },
  { guid: { sessionID: 7, localID: 6 }, type: 'TEXT', name: '分隔标', visible: true,
    parentIndex: { guid: { sessionID: 7, localID: 5 }, position: 'a' }, transform: xf(0, 0), size: { x: 80, y: 16 },
    textData: { characters: '在零尺寸容器里' } },
  // 零尺寸叶子无子 → 丢
  { guid: { sessionID: 7, localID: 7 }, type: 'FRAME', name: '零尺寸空', visible: true, parentIndex: pi2('e'),
    transform: xf(0, 200), size: { x: 0, y: 0 } },
];

test('D:逐角圆角 —— 不等出 tl/tr/br/bl,相等/统一出单值', () => {
  const { design } = designFromNodeChanges(cornerNodes, '7-1');
  const byName = Object.fromEntries((design.children || []).map((c) => [c.name, c]));
  assert.equal(byName['上圆角卡'].radius, '8/8/0/0');
  assert.equal(byName['四角同'].radius, 6);
  assert.equal(byName['统一角'].radius, 12);
});

test('C:零尺寸容器有可见子 → 保留;零尺寸空叶子 → 丢', () => {
  const { design } = designFromNodeChanges(cornerNodes, '7-1');
  const names = (design.children || []).map((c) => c.name);
  assert.ok(names.includes('零尺寸有子'), '零尺寸但有子的容器应保留');
  const kept = (design.children || []).find((c) => c.name === '零尺寸有子');
  assert.equal(kept.children?.[0]?.text, '在零尺寸容器里', '其文本子应在');
  assert.ok(!names.includes('零尺寸空'), '零尺寸且无子的叶子应被丢');
});
