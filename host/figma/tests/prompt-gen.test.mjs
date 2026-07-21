// /figma 提示词生成 + 命令识别(纯函数)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDevPrompt } from '../prompt-gen.mjs';
import { isFigmaCommand } from '../sidebar-command.mjs';
import { exchangeWebNuxt, stackText } from '../component-lib.mjs';

test('isFigmaCommand:仅 /figma 开头命中', () => {
  assert.equal(isFigmaCommand('/figma'), true);
  assert.equal(isFigmaCommand('  /figma 出提示词'), true);
  assert.equal(isFigmaCommand('/figmax'), false);
  assert.equal(isFigmaCommand('/qa x'), false);
});

const DESIGN = {
  type: 'FRAME', name: '活动页', box: { x: 0, y: 0, w: 375, h: 800 },
  layout: { dir: 'col', gap: 12, pad: [16, 16, 16, 16] },
  children: [
    { type: 'TEXT', name: '标题', text: 'TradFi 活动', box: { x: 16, y: 16, w: 200, h: 30 }, font: { size: 20, weight: 600 }, color: '#000000' },
    { type: 'INSTANCE', name: '按钮', component: 'PrimaryButton', box: { x: 16, y: 60, w: 343, h: 44 } },
  ],
};

test('buildDevPrompt:还原大纲 + 文案 + 组件标注 + 无组件库时退化提示', () => {
  const p = buildDevPrompt({ design: DESIGN, componentList: ['PrimaryButton'], pageName: 'TradFi 活动页' });
  assert.match(p, /TradFi 活动页/);
  assert.match(p, /TradFi 活动/); // 文案进大纲
  assert.match(p, /〔组件:PrimaryButton〕/); // 组件实例标注
  assert.match(p, /src\/components/); // 无组件库 → 退化提示
});

test('buildDevPrompt:注入组件库 → 列出可用组件 + 导入约定 + 技术栈', () => {
  const p = buildDevPrompt({
    design: DESIGN,
    stack: 'Nuxt2/Vue2.7 Options API + rem + Vuex + $t()',
    componentLib: { location: 'exchange-web-nuxt/src/components/common', importConvention: '全局注册直接用 <Button>', components: [{ name: 'Button', usage: '按钮' }, { name: 'page-container', usage: '页面容器' }] },
  });
  assert.match(p, /exchange-web-nuxt/);
  assert.match(p, /全局注册/);
  assert.match(p, /- Button — 按钮/);
  assert.match(p, /Nuxt2\/Vue2\.7/);
});

test('buildDevPrompt:icon / 图片 / 调色板 / 示样折叠 都渲染', () => {
  const design = { type: 'FRAME', name: 'p', box: { x: 0, y: 0, w: 100, h: 100 }, children: [
    { type: 'ICON', name: 'arrow', box: { x: 0, y: 0, w: 8, h: 8 } },
    { type: 'FRAME', name: 'img', image: true, imageUrl: 'https://x/i.png', box: { x: 0, y: 0, w: 50, h: 50 } },
    { type: 'FRAME', name: 'row', box: { x: 0, y: 0, w: 80, h: 20 }, repeat: 3 },
  ] };
  const p = buildDevPrompt({ design, palette: ['#000000', '#4d77ff'] });
  assert.match(p, /icon:arrow/);
  assert.match(p, /【图片:https:\/\/x\/i\.png】/);
  assert.match(p, /×3\(示样1条\)/);
  assert.match(p, /调色板/);
  assert.match(p, /#4d77ff/);
});

test('component-lib:exchange-web-nuxt 真实描述符接入 → 主站组件 + Vue2/rem', () => {
  const p = buildDevPrompt({ design: DESIGN, componentList: [], componentLib: exchangeWebNuxt, stack: stackText });
  assert.match(p, /page-container/);
  assert.match(p, /Vue 2\.7/);
  assert.match(p, /rem/);
  assert.match(p, /oil-activity/); // 带上现成范例指引
});
