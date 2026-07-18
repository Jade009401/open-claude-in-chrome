# generic_dom 通用降噪 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让侧栏 `browser_map` 在重复结构重页(交易/订单簿/feed)上建全地图、可总结,消除 `generic_dom_node_limit_reached`,方案通用无站点硬编码。

**Architecture:** 拆分落点 —— 采集器 `universal-browser-map.js` 做"同构兄弟折叠(样本+计数)";kernel `universal-map-kernel.js` 做"认 collapsed_group + 锚点优先预算 + coverage 随折叠软化"。折叠决策抽成纯函数便于单测;DOM 走查层靠端到端人工验证。

**Tech Stack:** 纯 JS(扩展 IIFE,attach 到 `globalThis`);测试用 node 内置 `node:test` + `node:vm`(零新依赖);node v20。

**Spec:** `docs/superpowers/specs/2026-07-18-generic-dom-降噪-design.md`

**关键约束(实现者必读):**
- 三个扩展文件是 IIFE:`(function(global){...})(globalThis)`,attach `ClaudeUniversalBrowserMapCore` / `ClaudeUniversalMapKernel` / `ClaudeUniversalBrowserMap`。`core.js` 全程无 DOM;`kernel.js` 无 DOM;`universal-browser-map.js` 仅在函数体内用 DOM,加载期安全。
- 测试用 `vm.runInThisContext` 按 core→kernel→browser-map 顺序加载,读 `globalThis.*`。
- 提交在当前分支 `spec/lark-prd-qa`,**不 push**。行为变化,实现完成需端到端验证证据。
- 常量默认:`COLLAPSE_MIN_GROUP=8` / `COLLAPSE_SAMPLES=3` / `GATHER_CEILING=25000` / 采集器 `maxNodes=6000`(不变)/ kernel `OUTPUT_NODE_BUDGET=5000`。

---

## File Structure

| 文件 | 职责 | 改动 |
|------|------|------|
| `extension/universal-browser-map.js` | 采集器:结构签名、planCollapse 纯函数、gather/plan/emit 两遍、collapsed_group 节点、collection 软化 | Modify |
| `extension/universal-map-kernel.js` | kernel:认 collapsed_group(CONTENT_TYPES/evidenceKey/promote 排除)、applyAnchorBudget、coverage 随折叠 | Modify |
| `test/collapse.test.js` | planCollapse / structuralSignature 单测 | Create |
| `test/kernel-budget.test.js` | applyAnchorBudget / coverage / collapsed_group 单测 | Create |
| `test/load-extension-globals.js` | 测试用加载器(vm 载入三 IIFE) | Create |

`core.js` 预计不动(下钻靠父子关系,`read`/`locate` 通用处理)。若实现中发现异常再回补,记为待验证点。

---

## Task 1: 测试加载器 + 冒烟

**Files:**
- Create: `test/load-extension-globals.js`
- Create: `test/smoke.test.js`

- [ ] **Step 1: 写加载器**

`test/load-extension-globals.js`:
```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(rel) {
  const file = path.join(__dirname, '..', 'extension', rel);
  const code = fs.readFileSync(file, 'utf8');
  vm.runInThisContext(code, { filename: rel }); // IIFE attaches to globalThis
}

// 顺序有依赖:core → kernel → browser-map
load('universal-browser-map-core.js');
load('universal-map-kernel.js');
load('universal-browser-map.js');

module.exports = {
  core: globalThis.ClaudeUniversalBrowserMapCore,
  kernel: globalThis.ClaudeUniversalMapKernel,
  bmap: globalThis.ClaudeUniversalBrowserMap,
};
```

- [ ] **Step 2: 写冒烟测试(先失败)**

`test/smoke.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { core, kernel, bmap } = require('./load-extension-globals');

test('三个全局都加载成功', () => {
  assert.ok(core && typeof core.hashString === 'function', 'core.hashString');
  assert.ok(kernel && typeof kernel.compileEvidenceBatches === 'function', 'kernel.compileEvidenceBatches');
  assert.ok(bmap && typeof bmap.scan === 'function', 'bmap.scan');
});
```

- [ ] **Step 3: 跑,确认通过(加载器本身即验证)**

Run: `node --test test/smoke.test.js`
Expected: PASS(若 FAIL 且报某文件加载期引用 DOM,则该文件加载期不安全,停下报告 —— 与设计前提冲突)

- [ ] **Step 4: 提交**

```bash
git add test/load-extension-globals.js test/smoke.test.js
git commit -m "test: 加扩展 IIFE 的 node 测试加载器 + 冒烟"
```

---

## Task 2: structuralSignature + planCollapse(纯函数)

**Files:**
- Modify: `extension/universal-browser-map.js`(新增两个函数 + 导出内部函数供测试)
- Create: `test/collapse.test.js`

- [ ] **Step 1: 写失败测试**

`test/collapse.test.js`:
```js
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
  const cand = Array.from({ length: 10 }, (_, i) => ({ parentKey: 1, signature: 'S' }));
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
```

- [ ] **Step 2: 跑,确认失败**

Run: `node --test test/collapse.test.js`
Expected: FAIL(`ClaudeUniversalBrowserMapInternals` 为 undefined)

- [ ] **Step 3: 实现**

在 `extension/universal-browser-map.js` 内 `roleOf` 函数之后加:
```js
  function normalizeClassShape(el) {
    const list = el.classList ? [...el.classList] : [];
    return list
      .map((c) => String(c).replace(/\d+/g, '').trim()) // 去动态数字 token(row-3 → row-)
      .filter(Boolean)
      .sort()
      .slice(0, 6)
      .join('.');
  }

  function structuralSignature(el) {
    const tag = el.tagName || '';
    const role = roleOf(el);
    const classShape = normalizeClassShape(el);
    const childTagShape = (el.children ? [...el.children] : []).map((c) => c.tagName).slice(0, 12).join(',');
    return `${tag}|${role}|${classShape}|${childTagShape}`;
  }

  // 纯函数:按 (parentKey|signature) 分组,≥minGroup 折叠、留前 samples 个样本。
  // 返回与输入等长的 decisions(action: full|sample|hidden)+ collapsedGroups 元数据。
  function planCollapse(candidates, options = {}) {
    const minGroup = Math.max(2, Number(options.minGroup ?? 8));
    const samples = Math.max(1, Number(options.samples ?? 3));
    const groupIndex = new Map();
    const groups = [];
    candidates.forEach((c, i) => {
      const key = `${c.parentKey} ${c.signature}`;
      let gid = groupIndex.get(key);
      if (gid === undefined) {
        gid = groups.length;
        groupIndex.set(key, gid);
        groups.push({ groupId: gid, parentKey: c.parentKey, signature: c.signature, memberIdx: [] });
      }
      groups[gid].memberIdx.push(i);
    });
    const decisions = candidates.map(() => ({ action: 'full', groupId: null }));
    const collapsedGroups = [];
    for (const g of groups) {
      if (g.memberIdx.length < minGroup) continue;
      collapsedGroups.push({
        groupId: g.groupId,
        parentKey: g.parentKey,
        signature: g.signature,
        totalCount: g.memberIdx.length,
        sampleIdx: g.memberIdx.slice(0, samples),
        hiddenCount: g.memberIdx.length - samples,
      });
      g.memberIdx.forEach((idx, pos) => {
        decisions[idx] = { action: pos < samples ? 'sample' : 'hidden', groupId: g.groupId };
      });
    }
    return { decisions, collapsedGroups };
  }
```

在文件末尾导出行 `global.ClaudeUniversalBrowserMap = { scan, act, resolveDomPath, state };` **之后** 加:
```js
  global.ClaudeUniversalBrowserMapInternals = { structuralSignature, planCollapse, normalizeClassShape };
```

- [ ] **Step 4: 跑,确认通过**

Run: `node --test test/collapse.test.js`
Expected: PASS(5 tests)

- [ ] **Step 5: 提交**

```bash
git add extension/universal-browser-map.js test/collapse.test.js
git commit -m "feat(collector): 结构签名 + planCollapse 纯函数(同构折叠决策)"
```

---

## Task 3: genericDomAdapter 接入折叠(gather/plan/emit)

**Files:**
- Modify: `extension/universal-browser-map.js`(重写 `genericDomAdapter` 主体 :140–179)

> 说明:DOM 走查层无自动化单测(零依赖不引 jsdom),靠 Task 7 端到端验证。纯逻辑已在 Task 2 覆盖。

- [ ] **Step 1: 在 `genericDomAdapter` 顶部加常量**

在 `function genericDomAdapter(options = {})` 内、`const maxNodes = ...` 之后加:
```js
    const COLLAPSE_MIN_GROUP = Math.max(2, Number(options.collapseMinGroup || 8));
    const COLLAPSE_SAMPLES = Math.max(1, Number(options.collapseSamples || 3));
    const GATHER_CEILING = Math.max(maxNodes, Number(options.gatherCeiling || 25000));
```

- [ ] **Step 2: 改造 `add` 支持 parentId 覆盖**

把现有 `add` 改为(新增第三参 `opts`):
```js
    const add = (element, raw, opts = {}) => {
      if (nodes.length >= maxNodes) return null;
      const id = raw.id || `dom_${core.hashString(`${location.href}|${safeAttributes(element).domPath}|${nodes.length}`)}`;
      elementIds.set(element, id);
      const parent = element.parentElement;
      const parentId = opts.parentIdOverride !== undefined
        ? opts.parentIdOverride
        : (parent ? elementIds.get(parent) || null : null);
      nodes.push({ id, parentId, frameId: 0, adapter: 'generic_dom', visible: isVisible(element), bounds: boundsOf(element), attributes: safeAttributes(element), ...raw });
      return id;
    };

    // 折叠组占位节点:parentId = 共享 DOM 父;样本 reparent 到它下面。
    const addCollapsedGroup = (parentElement, g, sampleCand) => {
      if (nodes.length >= maxNodes) return null;
      const parentId = parentElement ? (elementIds.get(parentElement) || null) : null;
      const id = `cg_${core.hashString(`${location.href}|${g.parentKey}|${g.signature}`)}`;
      const tag = (sampleCand.element.tagName || 'node').toLowerCase();
      const classHint = normalizeClassShape(sampleCand.element);
      nodes.push({
        id, parentId, frameId: 0, adapter: 'generic_dom',
        type: 'collapsed_group',
        role: sampleCand.raw.role,
        title: `${g.totalCount}× ${tag}${classHint ? '.' + classHint : ''}`,
        text: String(sampleCand.raw.text || '').slice(0, 120),
        collapsed: { signature: g.signature, totalCount: g.totalCount, hiddenCount: g.hiddenCount, sampleCount: g.sampleIdx.length },
        bounds: boundsOf(sampleCand.element),
        visible: true,
        attributes: { collapsed: true, signature: g.signature },
        confidence: 0.7,
      });
      return id;
    };
```

- [ ] **Step 3: 用 gather/plan/emit 替换现有 `for (const element of elements) {...}` 收集循环**

把 :157–177 的收集循环整体替换为:
```js
    // ---- Pass 1: gather 候选(套用与原逻辑一致的语义/文本过滤)----
    const candidates = [];
    const parentKeyMap = new WeakMap();
    let parentKeySeq = 0;
    for (const element of elements) {
      if (candidates.length >= GATHER_CEILING) break;
      const role = roleOf(element);
      const tag = element.tagName;
      const text = textOf(element);
      const isSemantic = semanticTags.has(tag) || element.hasAttribute('role') || element.hasAttribute('aria-label') || element.hasAttribute('data-testid');
      if (!isSemantic) continue;
      if (!text && !['INPUT','TEXTAREA','SELECT','CANVAS','IMG','TABLE','FORM'].includes(tag)) continue;
      if (tag === 'TR' || tag === 'TD' || tag === 'TH' || tag === 'TABLE') continue; // handled by table adapter
      const heading = /^H([1-6])$/.exec(tag);
      const raw = {
        type: heading ? 'document_section' : ['INPUT','TEXTAREA','SELECT','BUTTON','A'].includes(tag) ? 'control' : tag === 'CANVAS' ? 'canvas_surface' : tag === 'FORM' ? 'form' : tag === 'IMG' ? 'image' : 'dom_node',
        role,
        title: heading ? text : (element.getAttribute('aria-label') || element.getAttribute('name') || ''),
        text,
        level: heading ? Number(heading[1]) : undefined,
        number: heading ? core.extractLeadingNumber(text) : null,
        actionable: ['button','link','textbox','combobox','checkbox','radio'].includes(role),
        opaque: tag === 'CANVAS',
        confidence: heading ? 0.96 : 0.8,
      };
      const parentElement = element.parentElement;
      let parentKey = -1;
      if (parentElement) {
        if (!parentKeyMap.has(parentElement)) parentKeyMap.set(parentElement, ++parentKeySeq);
        parentKey = parentKeyMap.get(parentElement);
      }
      // 仅 dom_node 参与折叠;锚点(标题/控件/表单/图片)给唯一签名 → 永不成组,永远全留。
      const signature = raw.type === 'dom_node' ? structuralSignature(element) : `__keep__${candidates.length}`;
      candidates.push({ element, parentElement, parentKey, signature, raw });
    }

    // ---- Pass 2: plan ----
    const { decisions, collapsedGroups } = planCollapse(candidates, { minGroup: COLLAPSE_MIN_GROUP, samples: COLLAPSE_SAMPLES });
    const groupById = new Map(collapsedGroups.map((g) => [g.groupId, g]));
    const groupNodeId = new Map();

    // ---- Pass 3: emit(按原顺序;先父后子保证 parentId 可解析)----
    candidates.forEach((cand, i) => {
      const d = decisions[i];
      if (d.action === 'hidden') return;
      if (d.action === 'full') { add(cand.element, cand.raw); return; }
      // sample:确保折叠组节点已建,样本 reparent 到它
      let cgId = groupNodeId.get(d.groupId);
      if (cgId === undefined || cgId === null) {
        cgId = addCollapsedGroup(cand.parentElement, groupById.get(d.groupId), cand);
        groupNodeId.set(d.groupId, cgId);
      }
      add(cand.element, cand.raw, { parentIdOverride: cgId });
    });
```

- [ ] **Step 4: 改 return 的 collection(软化 + warnings)**

把 :178–179 的 `const truncated = ...; return {...}` 替换为:
```js
    const truncated = nodes.length >= maxNodes;
    const collapsedCount = collapsedGroups.length;
    const hiddenNodes = collapsedGroups.reduce((sum, g) => sum + g.hiddenCount, 0);
    const collapseWarnings = collapsedCount ? [`${collapsedCount} repeated regions collapsed (${hiddenNodes} nodes hidden)`] : [];
    return {
      adapter: 'generic_dom',
      nodes,
      capabilities: ['dom', 'shadow_dom', 'semantic_elements', 'controls'],
      collection: {
        status: truncated ? 'truncated' : 'snapshot_complete',
        frontier: 'snapshot_complete',
        truncated,
        limitReached: truncated,
        unresolvedRegions: 0,
        nodeCount: nodes.length,
        collapsedGroups: collapsedCount,
        hiddenNodes,
        warnings: collapseWarnings,
        reasons: truncated ? ['generic_dom_node_limit_reached'] : [],
      },
    };
```

- [ ] **Step 5: 跑既有测试确认未回归**

Run: `node --test test/`
Expected: PASS(smoke + collapse 全绿;本任务不新增断言)

- [ ] **Step 6: 提交**

```bash
git add extension/universal-browser-map.js
git commit -m "feat(collector): genericDomAdapter 接入两遍折叠 + collapsed_group + collection 软化"
```

---

## Task 4: kernel 认 collapsed_group

**Files:**
- Modify: `extension/universal-map-kernel.js`(CONTENT_TYPES / evidenceKey / promoteNumberedAnchor)
- Create: `test/kernel-budget.test.js`(本任务加 collapsed_group 相关断言)

- [ ] **Step 1: 写失败测试**

`test/kernel-budget.test.js`:
```js
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
```

> 三条断言分别对应 Step 3 的三处编辑:`scope=content` ← CONTENT_TYPES;`length===2` ← evidenceKey 分支;`编号 run 不 promote` ← promote 正则排除。均为真 red→green。

- [ ] **Step 2: 跑,确认失败**

Run: `node --test test/kernel-budget.test.js`
Expected: FAIL —— 未加 CONTENT_TYPES 时 `scopeHint` 为 `unknown` 非 `content`;未加 evidenceKey 分支时同签名折叠组被 `semantic:` key 合并成 1 个;未加 promote 排除时编号 run 中的折叠组被升级为 `document_section`

- [ ] **Step 3: 实现三处改动**

(a) `CONTENT_TYPES`(:11–15)数组里加 `'collapsed_group'`:
```js
    'application', 'region', 'form', 'control', 'dialog', 'data_field', 'image', 'attachment', 'collapsed_group',
```

(b) `evidenceKey`(:162)在 `if (type === 'document') return ...;` 之后、numbered 分支之前加:
```js
    if (type === 'collapsed_group') {
      const sig = core.normalizeText(node.collapsed?.signature || node.attributes?.signature || '');
      return `collapse:${frameId}:${sig}:${node.parentId || ''}`;
    }
```

(c) `promoteNumberedAnchor`(:145)把 collapsed_group 排除 —— 正则加 `collapsed_group`:
```js
    if (!runSet.has(Number(number)) || /document_section|table|cell|code|control|input|collapsed_group/.test(type)) return node;
```

- [ ] **Step 4: 跑,确认通过**

Run: `node --test test/kernel-budget.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add extension/universal-map-kernel.js test/kernel-budget.test.js
git commit -m "feat(kernel): 认 collapsed_group(CONTENT_TYPES/evidenceKey/promote 排除)"
```

---

## Task 5: kernel 锚点优先预算 applyAnchorBudget

**Files:**
- Modify: `extension/universal-map-kernel.js`(新增 `OUTPUT_NODE_BUDGET`、`anchorRank`、`applyAnchorBudget`;在 compile 里调用 + 导出)
- Modify: `test/kernel-budget.test.js`(加预算断言)

- [ ] **Step 1: 追加失败测试**

在 `test/kernel-budget.test.js` 末尾追加:
```js
test('applyAnchorBudget:超预算时保锚点、砍纯文本、父链不断', () => {
  const nodes = [];
  nodes.push({ id: 'h1', type: 'document_section', parentId: null, title: '标题', level: 2, number: null });
  nodes.push({ id: 'btn', type: 'control', parentId: 'h1', title: '下单', role: 'button' });
  // 大量纯 dom_node 文本(chrome scope 优先被砍)
  for (let i = 0; i < 50; i += 1) nodes.push({ id: `t${i}`, type: 'dom_node', parentId: null, text: `噪声${i}`, scopeHint: 'chrome' });
  const kept = kernel.applyAnchorBudget(nodes, 5);
  const ids = new Set(kept.map((n) => n.id));
  assert.ok(ids.has('h1') && ids.has('btn'), '锚点必须保留');
  assert.ok(kept.length <= 5 + 2, '预算软上限(+父链余量)');
  // 父链不断:btn 的父 h1 在集合内
  for (const n of kept) if (n.parentId) assert.ok(ids.has(n.parentId), `父 ${n.parentId} 应在集合内`);
});
```

- [ ] **Step 2: 跑,确认失败**

Run: `node --test test/kernel-budget.test.js`
Expected: FAIL(`kernel.applyAnchorBudget` 不是函数)

- [ ] **Step 3: 实现**

在 kernel 顶部常量区(`KERNEL_SCHEMA_VERSION` 附近)加:
```js
  const OUTPUT_NODE_BUDGET = 5000;
```

在 `mergeGroup` 之后、`compileEvidenceBatches` 之前加:
```js
  function anchorRank(node) {
    const type = core.normalizeText(node.type || '').toLowerCase();
    const scope = core.normalizeText(node.scopeHint || node.attributes?.scopeHint || '').toLowerCase();
    if (/document_section|heading|^document$/.test(type) || node.level) return 100;
    if (type === 'control' || type === 'form') return 90;
    if (type === 'collapsed_group') return 80;
    if (Number.isFinite(Number(node.number)) && Number(node.number)) return 70;
    if (core.normalizeText(node.title) || node.attributes?.['aria-label']) return 50;
    if (scope === 'chrome' || scope === 'navigation') return 10; // 纯装饰/导航文本最先砍
    return 30;
  }

  // 超预算时按锚点优先保留;并保留被留节点的祖先链(不产生孤儿)。软上限。
  function applyAnchorBudget(nodes, budget = OUTPUT_NODE_BUDGET) {
    if (!Array.isArray(nodes) || nodes.length <= budget) return nodes || [];
    const byId = new Map(nodes.map((n) => [String(n.id), n]));
    const ranked = nodes.map((n, i) => ({ n, i, r: anchorRank(n) })).sort((a, b) => (b.r - a.r) || (a.i - b.i));
    const keep = new Set();
    for (const { n } of ranked) {
      if (keep.size >= budget) break;
      keep.add(String(n.id));
    }
    for (const id of [...keep]) {
      let cur = byId.get(id);
      let guard = 0;
      while (cur && cur.parentId && !keep.has(String(cur.parentId)) && guard++ < 64) {
        keep.add(String(cur.parentId));
        cur = byId.get(String(cur.parentId));
      }
    }
    return nodes.filter((n) => keep.has(String(n.id)));
  }
```

在 `compileEvidenceBatches` 里,`const mergedNodes = mergedGroups.map(...)`(:374–378)之后加一行,并让后续 `buildMap`/coverage 用预算后的集合:
```js
    const budgetedNodes = applyAnchorBudget(mergedNodes, OUTPUT_NODE_BUDGET);
```
- 把随后(:380)`coverageFromBatches(batches, mergedNodes.length)` 的第二参改为 `budgetedNodes.length`(coverage 报预算后节点数,更准);
- 把 `core.buildMap([{ adapter: 'universal_map_kernel', nodes: mergedNodes, ...`(:383)中的 `nodes: mergedNodes` 改为 `nodes: budgetedNodes`;
- 把末尾 `map.kernelTrace`(:403)里 `mergedTotal: mergedNodes.length` 改为 `mergedTotal: budgetedNodes.length`,并新增 `budgetApplied: budgetedNodes.length < mergedNodes.length`。

在 `const api = { ... }` 导出对象里加 `applyAnchorBudget`:
```js
    applyAnchorBudget,
```

- [ ] **Step 4: 跑,确认通过**

Run: `node --test test/`
Expected: PASS(全部)

- [ ] **Step 5: 提交**

```bash
git add extension/universal-map-kernel.js test/kernel-budget.test.js
git commit -m "feat(kernel): 锚点优先全局预算 applyAnchorBudget(超限保锚点/断父链)"
```

---

## Task 6: coverage 随折叠软化(行为锁定)

**Files:**
- Modify: `test/kernel-budget.test.js`(加 coverage 断言)

> 说明:coverage 软化在 Task 3(collector 折叠成功 → `status:'snapshot_complete'`、`truncated:false`、warnings 有值)+ 现有 `normalizeCollection`/`coverageFromBatches` 逻辑下**自动成立**(complete 判定见 kernel :83)。本任务只用测试锁定,防回归;若断言不过说明前序有缺口,回头修 Task 3。

- [ ] **Step 1: 追加测试**

在 `test/kernel-budget.test.js` 末尾追加:
```js
test('coverage:折叠(有 warnings 无 reasons)→ complete_with_warnings,不 incomplete', () => {
  const nodes = [{ id: 'cg1', type: 'collapsed_group', parentId: null, title: '500× div.row', collapsed: { signature: 'DIV|row', totalCount: 500, hiddenCount: 497 }, attributes: { signature: 'DIV|row' } }];
  const b = kernel.evidenceBatchFromFragment(
    { adapter: 'generic_dom', nodes, capabilities: [], collection: { status: 'snapshot_complete', truncated: false, limitReached: false, nodeCount: 1, collapsedGroups: 1, hiddenNodes: 497, warnings: ['1 repeated regions collapsed (497 nodes hidden)'], reasons: [] } },
    { collector: 'generic_dom', role: 'primary', required: true, authority: 'derived' },
  );
  const map = kernel.compileEvidenceBatches([b], { url: 'https://x.test' });
  assert.notStrictEqual(map.mapCoverage.status, 'incomplete');
  assert.ok(map.mapCoverage.warnings.some((w) => /collapsed/.test(w)), 'warning 应透出');
});

test('coverage:真截断(truncated+reasons)→ 仍 incomplete(诚实)', () => {
  const nodes = [{ id: 'n1', type: 'dom_node', parentId: null, text: 'x' }];
  const b = kernel.evidenceBatchFromFragment(
    { adapter: 'generic_dom', nodes, capabilities: [], collection: { status: 'truncated', truncated: true, limitReached: true, nodeCount: 1, warnings: [], reasons: ['generic_dom_node_limit_reached'] } },
    { collector: 'generic_dom', role: 'primary', required: true, authority: 'derived' },
  );
  const map = kernel.compileEvidenceBatches([b], { url: 'https://x.test' });
  assert.strictEqual(map.mapCoverage.status, 'incomplete');
});
```

- [ ] **Step 2: 跑**

Run: `node --test test/kernel-budget.test.js`
Expected: PASS(若第一条 FAIL,回 Task 3 检查 collector collection 字段)

- [ ] **Step 3: 提交**

```bash
git add test/kernel-budget.test.js
git commit -m "test(kernel): 锁定 coverage 随折叠软化 / 真截断仍诚实 incomplete"
```

---

## Task 7: fork 溯源注释 + 端到端验证 + 收尾

**Files:**
- Modify: `extension/universal-browser-map.js`、`extension/universal-map-kernel.js`(文件头注释)

- [ ] **Step 1: 两文件头加溯源注释**

在两文件首行 `(function (global) {` **之前** 各加:
```js
// 本文件为本仓库事实源(single source of truth)。已从 v0.15.3 分叉并含降噪改造,
// 勿用 install-macos.sh / ~/Downloads vendor 覆盖。见 docs/superpowers/specs/2026-07-18-generic-dom-降噪-design.md
```

- [ ] **Step 2: 全量单测**

Run: `node --test test/`
Expected: PASS(smoke + collapse + kernel-budget 全绿)

- [ ] **Step 3: 端到端人工验证(浏览器,采集器 DOM 层唯一验证途径)**

1. `chrome://extensions` → 重新加载本扩展(改了注入的 `.js`)。
2. 打开触发过 bug 的交易页(~6269 节点)。
3. 通过侧栏触发 `browser_map`(或 mcp `browser_map`)。
4. 断言(记录证据):
   - 返回的 map `mapCoverage.status` **不是** `incomplete`(应为 `complete` 或 `complete_with_warnings`);
   - `diagnostics`/collectors 无 `generic_dom_node_limit_reached`;
   - map 含标题/控件类锚点节点 + 若干 `type:'collapsed_group'`(带 `collapsed.totalCount`);
   - Claude 能对该页出总结(原 bug 消除)。
5. 抽查一个 `collapsed_group` 的样本节点:`locate`/`act`(scroll_into_view 或 click)成功。

> 若步骤 4 仍报 limit:确认折叠是否命中(签名是否过细导致不成组)—— 调 `COLLAPSE_MIN_GROUP` 或增强签名,回 Task 3。若过度折叠(锚点被吞)—— 检查"仅 dom_node 参与折叠"分支。

- [ ] **Step 4: 提交**

```bash
git add extension/universal-browser-map.js extension/universal-map-kernel.js
git commit -m "docs+chore: fork 溯源注释,降噪端到端验证通过"
```

- [ ] **Step 5: 汇报**(不 push;是否推 fork 由用户单独确认)

给出:全量单测输出 + 端到端 4/5 步的实测结果(截图或 map 关键字段)作为完成证据。

---

## 完成标准(Definition of Done)
- `node --test test/` 全绿(smoke / collapse / kernel-budget)。
- 交易页端到端:map 不再 `incomplete`、无 `generic_dom_node_limit_reached`、含 collapsed_group + 锚点、可总结、样本可操作。
- 零站点硬编码;仅动 2 个扩展文件 + test/;host 不变;未 push。

## 已知限制(不在本计划范围)
- 折叠后仍 >6000 的"超大且全唯一"页 → 采集器 BFS 序盲截,诚实 `incomplete`(后续可加采集器锚点截断硬化)。
- 每条隐藏行不可逐条读取(按定:样本可操作 + 其余仅计数)。
- `core.js` 若对 `collapsed_group` 有 `read`/`locate` 异常再回补(待验证点)。
