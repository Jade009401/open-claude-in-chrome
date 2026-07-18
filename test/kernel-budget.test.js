'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
require('./load-extension-globals');
const kernel = globalThis.ClaudeUniversalMapKernel;

function batch(nodes, extra = {}) {
  return kernel.evidenceBatchFromFragment(
    { adapter: 'generic_dom', nodes, capabilities: [], collection: { status: 'snapshot_complete', nodeCount: nodes.length, ...(extra.collection || {}) } },
    { collector: 'generic_dom', role: 'primary', required: true, authority: 'derived' },
  );
}

test('collapsed_group:scope=content(CONTENT_TYPES)、同签名不同父不合并(evidenceKey)', () => {
  const nodes = [
    { id: 'cg1', type: 'collapsed_group', parentId: 'pA', title: '500× div.row', collapsed: { signature: 'DIV|row', totalCount: 500, hiddenCount: 497 }, attributes: { signature: 'DIV|row' }, confidence: 0.7 },
    { id: 'cg2', type: 'collapsed_group', parentId: 'pB', title: '500× div.row', collapsed: { signature: 'DIV|row', totalCount: 500, hiddenCount: 497 }, attributes: { signature: 'DIV|row' }, confidence: 0.7 },
  ];
  const map = kernel.compileEvidenceBatches([batch(nodes)], { url: 'https://x.test' });
  const cgs = map.nodes.filter((n) => n.type === 'collapsed_group');
  assert.strictEqual(cgs.length, 2, '同签名但不同 parentId 的折叠组不应被合并(需 evidenceKey 用 parentId 区分)');
  assert.ok(cgs.every((n) => n.scopeHint === 'content'), 'collapsed_group 应归为 content(需 CONTENT_TYPES)');
});

test('collapsed_group:处在编号 run 中也不被 promote 为 document_section(promote 排除)', () => {
  // 4/5/6 连续编号 → numberedRunSet 命中 5;若不排除,label 带 5 的折叠组会被升级。
  const nodes = [
    { id: 'a', type: 'dom_node', parentId: null, title: '4 项' },
    { id: 'cg', type: 'collapsed_group', parentId: 'p', title: '5 组', collapsed: { signature: 'S', totalCount: 20, hiddenCount: 17 }, attributes: { signature: 'S' } },
    { id: 'c', type: 'dom_node', parentId: null, title: '6 项' },
  ];
  const map = kernel.compileEvidenceBatches([batch(nodes)], { url: 'https://x.test' });
  const cg = map.nodes.find((n) => n.collapsed); // 用 collapsed 字段找,类型即便被误改也能定位
  assert.ok(cg, 'collapsed_group 应保留');
  assert.notStrictEqual(cg.type, 'document_section', '编号 run 中也不应被 promote(需 promote 排除)');
});
