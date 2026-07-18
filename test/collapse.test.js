'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
require('./load-extension-globals');
const internals = globalThis.ClaudeUniversalBrowserMapInternals;

function stubEl(tag, { role, classes = [], childTags = [] } = {}) {
  return {
    tagName: tag,
    getAttribute: (k) => (k === 'role' ? (role || null) : null),
    classList: classes,
    children: childTags.map((t) => ({ tagName: t })),
  };
}

test('structuralSignature:同构行签名相同、去动态数字 class', () => {
  const a = stubEl('DIV', { classes: ['row', 'row-3'], childTags: ['SPAN', 'SPAN'] });
  const b = stubEl('DIV', { classes: ['row', 'row-77'], childTags: ['SPAN', 'SPAN'] });
  assert.strictEqual(internals.structuralSignature(a), internals.structuralSignature(b));
});

test('structuralSignature:不同子结构签名不同', () => {
  const a = stubEl('DIV', { childTags: ['SPAN', 'SPAN'] });
  const b = stubEl('DIV', { childTags: ['SPAN', 'BUTTON'] });
  assert.notStrictEqual(internals.structuralSignature(a), internals.structuralSignature(b));
});

test('planCollapse:≥阈值折叠,留样本,其余隐藏', () => {
  const cand = Array.from({ length: 10 }, () => ({ parentKey: 1, signature: 'S' }));
  const { decisions, collapsedGroups } = internals.planCollapse(cand, { minGroup: 8, samples: 3 });
  assert.strictEqual(collapsedGroups.length, 1);
  assert.strictEqual(collapsedGroups[0].totalCount, 10);
  assert.strictEqual(collapsedGroups[0].hiddenCount, 7);
  assert.deepStrictEqual(decisions.map((d) => d.action), ['sample','sample','sample','hidden','hidden','hidden','hidden','hidden','hidden','hidden']);
});

test('planCollapse:<阈值全留,不折叠', () => {
  const cand = Array.from({ length: 5 }, () => ({ parentKey: 1, signature: 'S' }));
  const { decisions, collapsedGroups } = internals.planCollapse(cand, { minGroup: 8, samples: 3 });
  assert.strictEqual(collapsedGroups.length, 0);
  assert.ok(decisions.every((d) => d.action === 'full'));
});

test('planCollapse:不同父/不同签名分组独立', () => {
  const cand = [
    ...Array.from({ length: 9 }, () => ({ parentKey: 1, signature: 'A' })),
    ...Array.from({ length: 9 }, () => ({ parentKey: 2, signature: 'A' })),
    ...Array.from({ length: 3 }, () => ({ parentKey: 1, signature: 'B' })),
  ];
  const { collapsedGroups } = internals.planCollapse(cand, { minGroup: 8, samples: 3 });
  assert.strictEqual(collapsedGroups.length, 2); // 两组 9 个折叠,B 组 3 个不折
});
