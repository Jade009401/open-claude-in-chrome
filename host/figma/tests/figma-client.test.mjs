// Figma 适配器纯函数测试:URL 解析 + 压缩(REST IO 靠真 token live 验)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFigmaUrl, compactDesign, collectPalette } from '../figma-client.mjs';

test('parseFigmaUrl:/design/<key>?node-id=A-B → fileKey + nodeId(- → :)', () => {
  const r = parseFigmaUrl('https://www.figma.com/design/sjt9CYyypmufGaMfbPfHOZ/New-Biconomy?node-id=149106-66368&t=x');
  assert.equal(r.fileKey, 'sjt9CYyypmufGaMfbPfHOZ');
  assert.equal(r.nodeId, '149106:66368');
});

test('parseFigmaUrl:旧式 /file/ 也支持', () => {
  assert.equal(parseFigmaUrl('https://www.figma.com/file/ABC/Name?node-id=1-2').nodeId, '1:2');
  assert.equal(parseFigmaUrl('bad').fileKey, null);
});

const FIXTURE = {
  type: 'FRAME', name: '活动页', visible: true,
  absoluteBoundingBox: { x: 100, y: 200, width: 375, height: 800 },
  layoutMode: 'VERTICAL', itemSpacing: 12, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16,
  fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
  children: [
    { type: 'TEXT', name: '标题', characters: 'TradFi 活动', absoluteBoundingBox: { x: 116, y: 216, width: 200, height: 30 }, style: { fontSize: 20, fontWeight: 600 }, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] },
    { type: 'INSTANCE', name: '按钮实例', componentId: 'C1', absoluteBoundingBox: { x: 116, y: 260, width: 343, height: 44 }, children: [{ type: 'TEXT', name: '深子', characters: '不该展开' }] },
    { type: 'FRAME', name: '卡片', absoluteBoundingBox: { x: 116, y: 320, width: 343, height: 80 } },
    { type: 'FRAME', name: '卡片', absoluteBoundingBox: { x: 116, y: 408, width: 343, height: 80 } },
    { type: 'FRAME', name: '卡片', absoluteBoundingBox: { x: 116, y: 496, width: 343, height: 80 } },
  ],
};

test('compactDesign:相对坐标 + 文案 + auto-layout + 组件不展开 + 同款折叠', () => {
  const d = compactDesign(FIXTURE, { components: { C1: { name: 'PrimaryButton' } } });
  assert.equal(d.type, 'FRAME');
  assert.deepEqual(d.box, { x: 100, y: 200, w: 375, h: 800 }); // 顶层绝对
  assert.equal(d.layout.dir, 'col');
  assert.equal(d.layout.gap, 12);
  assert.deepEqual(d.layout.pad, [16, 16, 16, 16]);
  const title = d.children.find((c) => c.name === '标题');
  assert.equal(title.text, 'TradFi 活动');
  assert.deepEqual(title.box, { x: 16, y: 16, w: 200, h: 30 }); // 相对父
  assert.equal(title.font.size, 20);
  const inst = d.children.find((c) => c.type === 'INSTANCE');
  assert.equal(inst.component, 'PrimaryButton');
  assert.ok(!inst.children, '组件实例不展开子树');
  const card = d.children.find((c) => c.name === '卡片');
  assert.equal(card.repeat, 3, '三张同款卡片折叠成一条 + repeat=3');
});

test('compactDesign:矢量→icon 叶;全矢量小容器→icon 叶(降噪)', () => {
  const d = compactDesign({
    type: 'FRAME', name: 'root', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
    children: [
      { type: 'VECTOR', name: 'arrow', absoluteBoundingBox: { x: 0, y: 0, width: 8, height: 8 } },
      { type: 'FRAME', name: 'download', absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 }, children: [
        { type: 'VECTOR', name: 'v1', absoluteBoundingBox: { x: 0, y: 0, width: 8, height: 8 } },
        { type: 'VECTOR', name: 'v2', absoluteBoundingBox: { x: 0, y: 0, width: 6, height: 6 } },
      ] },
    ],
  });
  assert.equal(d.children[0].type, 'ICON'); // 纯矢量
  assert.equal(d.children[0].name, 'arrow');
  assert.equal(d.children[1].type, 'ICON'); // 全矢量小容器
  assert.equal(d.children[1].name, 'download');
  assert.ok(!d.children[1].children, 'icon 容器不下钻');
});

test('compactDesign:结构相同(即使名字不同)也折叠成示样 ×N', () => {
  const row = (name, y) => ({ type: 'FRAME', name, absoluteBoundingBox: { x: 0, y, width: 300, height: 60 }, children: [{ type: 'TEXT', name: 't', characters: 'x', absoluteBoundingBox: { x: 0, y, width: 50, height: 20 } }] });
  const d = compactDesign({ type: 'FRAME', name: 'list', absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 }, children: [row('rowA', 0), row('rowB', 60), row('rowC', 120)] });
  assert.equal(d.children.length, 1, '三行结构相同 → 折叠一条');
  assert.equal(d.children[0].repeat, 3);
});

test('collectPalette:去重收集 fill/color', () => {
  const p = [...collectPalette({ fill: '#000', children: [{ color: '#fff' }, { fill: '#000' }, { type: 'TEXT', color: '#fff' }] })];
  assert.deepEqual(p.sort(), ['#000', '#fff']);
});

test('compactDesign:visible=false 跳过 + 限深不下钻', () => {
  assert.equal(compactDesign({ type: 'FRAME', name: 'x', visible: false }), null);
  const deep = compactDesign({ type: 'FRAME', name: 'r', absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 }, children: [{ type: 'FRAME', name: 'a' }] }, { maxDepth: 0 });
  assert.ok(!deep.children, 'maxDepth 0 不下钻');
});
