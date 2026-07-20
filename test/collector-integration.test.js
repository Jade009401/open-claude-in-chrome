'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
require('./load-extension-globals');
const internals = globalThis.ClaudeUniversalBrowserMapInternals;
const kernel = globalThis.ClaudeUniversalMapKernel;

// --- 极简 DOM stub:只满足 genericDomAdapter 走查所需(无 jsdom,零依赖)---
class El {}
class Doc {}
class Shadow {}
globalThis.Element = El;
globalThis.Document = Doc;
globalThis.ShadowRoot = Shadow;
globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
globalThis.CSS = { escape: (s) => String(s) };
globalThis.location = { href: 'https://trade.example/x', hostname: 'trade.example' };

function el(tag, opts = {}) {
  const e = Object.assign(new El(), {
    tagName: tag,
    nodeType: 1,
    id: opts.id || '',
    classList: opts.classes || [],
    innerText: opts.text || '',
    textContent: opts.text || '',
    shadowRoot: null,
    parentElement: null,
    children: [],
    _attrs: opts.attrs || {},
    getAttribute(k) { if (k === 'id') return this.id || null; return k in this._attrs ? this._attrs[k] : null; },
    hasAttribute(k) { if (k === 'id') return !!this.id; return k in this._attrs; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }; },
    getRootNode() { return globalThis.document; },
  });
  for (const c of opts.kids || []) { c.parentElement = e; e.children.push(c); }
  return e;
}

// 一个重复结构重页:12 条同构订单簿行(role=row)+ 标题 + 按钮
function buildHeavyDoc() {
  const rows = Array.from({ length: 12 }, (_, i) => el('DIV', {
    attrs: { role: 'row' },
    classes: ['row', `row-${i}`],
    text: `price ${i}`,
    kids: [el('SPAN', { text: 'p' }), el('SPAN', { text: 'q' })],
  }));
  const heading = el('H2', { text: 'Order Book' });
  const button = el('BUTTON', { text: 'Buy' });
  const container = el('DIV', { kids: [heading, ...rows, button] });
  const body = el('BODY', { kids: [container] });
  return Object.assign(new Doc(), {
    title: 'Trade',
    children: [body],
    documentElement: { dataset: {} },
    querySelectorAll: () => [],
  });
}

test('集成:重复行折叠为 collapsed_group、锚点保留、collection 不 truncated', () => {
  globalThis.document = buildHeavyDoc();
  const frag = internals.genericDomAdapter({ collapseMinGroup: 8, collapseSamples: 3 });
  const cg = frag.nodes.filter((n) => n.type === 'collapsed_group');
  const samples = frag.nodes.filter((n) => n.type === 'dom_node');
  const heading = frag.nodes.find((n) => n.type === 'document_section');
  const button = frag.nodes.find((n) => n.type === 'control');
  assert.strictEqual(cg.length, 1, '应产生 1 个折叠组');
  assert.strictEqual(cg[0].collapsed.totalCount, 12);
  assert.strictEqual(cg[0].collapsed.hiddenCount, 9);
  assert.strictEqual(samples.length, 3, '只保留 3 个样本行');
  assert.ok(heading, '标题锚点保留');
  assert.ok(button, '按钮锚点保留');
  assert.ok(samples.every((r) => r.parentId === cg[0].id), '样本 parentId 指向折叠组');
  assert.strictEqual(frag.collection.truncated, false);
  assert.strictEqual(frag.collection.collapsedGroups, 1);
  assert.ok(frag.collection.warnings.some((w) => /collapsed/.test(w)));
});

test('集成:折叠后经 kernel 建图,含折叠组+锚点、coverage 不 incomplete', () => {
  globalThis.document = buildHeavyDoc();
  const frag = internals.genericDomAdapter({ collapseMinGroup: 8, collapseSamples: 3 });
  const batch = kernel.evidenceBatchFromFragment(frag, { collector: 'generic_dom', role: 'primary', required: true, authority: 'derived' });
  const map = kernel.compileEvidenceBatches([batch], { url: 'https://trade.example/x' });
  assert.ok(map.nodes.some((n) => n.type === 'collapsed_group'), '地图含折叠组');
  assert.ok(map.nodes.some((n) => n.type === 'control'), '地图含控件锚点');
  assert.notStrictEqual(map.mapCoverage.status, 'incomplete', 'coverage 不应 incomplete');
});
