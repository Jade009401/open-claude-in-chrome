(function (global) {
  'use strict';

  const core = global.ClaudeUniversalBrowserMapCore;
  if (!core) throw new Error('ClaudeUniversalBrowserMapCore is required');

  const KERNEL_SCHEMA_VERSION = 1;
  const OUTPUT_NODE_BUDGET = 5000;
  const COMPLETE_STATES = new Set(['complete', 'ready', 'stable_end', 'snapshot_complete', 'authoritative_complete']);
  const INCOMPLETE_STATES = new Set(['incomplete', 'failed', 'error', 'truncated']);
  const CHROME_ROLES = new Set(['toolbar', 'navigation', 'banner', 'complementary', 'menubar', 'menu', 'status', 'header', 'footer']);
  const CONTENT_TYPES = new Set([
    'document', 'document_section', 'document_block', 'table', 'table_row', 'table_cell',
    'sheet', 'sheet_cell', 'figma_canvas', 'figma_node', 'canvas_surface', 'canvas_node',
    'application', 'region', 'form', 'control', 'dialog', 'data_field', 'image', 'attachment', 'collapsed_group',
  ]);

  const SOURCE_PRIORITY = Object.freeze({
    figma_plugin: 120,
    application_model: 116,
    lark_document: 112,
    virtual_document: 108,
    spreadsheet: 104,
    virtual_table: 102,
    structured_app: 98,
    document_dom: 88,
    table_dom: 84,
    accessibility: 72,
    generic_dom: 64,
    visual: 40,
    unknown: 20,
  });

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function normalizedCollector(value) {
    return core.normalizeText(value || 'unknown').toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'unknown';
  }

  function sourcePriority(collector, explicit) {
    if (Number.isFinite(Number(explicit))) return Number(explicit);
    const key = normalizedCollector(collector);
    if (Object.prototype.hasOwnProperty.call(SOURCE_PRIORITY, key)) return SOURCE_PRIORITY[key];
    for (const [prefix, priority] of Object.entries(SOURCE_PRIORITY)) {
      if (key.startsWith(`${prefix}_`) || key.includes(prefix)) return priority;
    }
    return SOURCE_PRIORITY.unknown;
  }

  function inferScopeHint(node = {}) {
    const explicit = core.normalizeText(node.scopeHint || node.attributes?.scopeHint || node.evidence?.scopeHint).toLowerCase();
    if (['content', 'chrome', 'navigation', 'decorative', 'unknown'].includes(explicit)) return explicit;
    const role = core.normalizeText(node.role || '').toLowerCase();
    const tag = core.normalizeText(node.attributes?.tagName || node.attributes?.tag || '').toLowerCase();
    const type = core.normalizeText(node.type || '').toLowerCase();
    const label = core.normalizeText(node.title || node.text || '');
    if (CHROME_ROLES.has(role) || ['nav', 'aside', 'header', 'footer'].includes(tag)) return role === 'navigation' || tag === 'nav' ? 'navigation' : 'chrome';
    if (['main', 'article', 'document'].includes(role) || ['main', 'article'].includes(tag)) return 'content';
    if ((type === 'image' || type === 'canvas_surface') && !label && !node.sourceId) return 'decorative';
    if (CONTENT_TYPES.has(type)) return 'content';
    return 'unknown';
  }

  function normalizeCollection(fragment = {}, options = {}) {
    const source = fragment.collection || {};
    const legacyComplete = fragment.completeness?.complete;
    let status = core.normalizeText(source.status || source.frontier || '').toLowerCase();
    if (!status) status = legacyComplete === false ? 'incomplete' : 'complete';
    const reasons = [...new Set([
      ...(Array.isArray(source.reasons) ? source.reasons : []),
      ...(Array.isArray(fragment.completeness?.reasons) ? fragment.completeness.reasons : []),
    ].filter(Boolean).map(String))];
    const warnings = [...new Set([
      ...(Array.isArray(source.warnings) ? source.warnings : []),
      ...(Array.isArray(options.warnings) ? options.warnings : []),
    ].filter(Boolean).map(String))];
    const truncated = source.truncated === true || status === 'truncated';
    const limitReached = source.limitReached === true;
    const unresolvedRegions = Math.max(0, Number(source.unresolvedRegions || 0));
    const failed = source.failed === true || INCOMPLETE_STATES.has(status) || legacyComplete === false;
    const complete = !failed && !truncated && !limitReached && unresolvedRegions === 0
      && (COMPLETE_STATES.has(status) || status === 'complete_with_warnings');
    return {
      status,
      frontier: core.normalizeText(source.frontier || status || 'unknown'),
      complete,
      failed,
      truncated,
      limitReached,
      unresolvedRegions,
      passes: Math.max(0, Number(source.passes || 0)),
      newNodesOnLastPass: Math.max(0, Number(source.newNodesOnLastPass || 0)),
      reasons,
      warnings,
      nodeCount: Math.max(0, Number(source.nodeCount ?? fragment.nodes?.length ?? 0)),
    };
  }

  function evidenceBatchFromFragment(fragment = {}, options = {}) {
    const collector = normalizedCollector(options.collector || fragment.collector || fragment.adapter || 'unknown');
    const role = ['primary', 'supporting', 'fallback'].includes(options.role || fragment.role)
      ? (options.role || fragment.role)
      : 'supporting';
    const required = options.required !== undefined ? options.required === true : role === 'primary';
    const authority = core.normalizeText(options.authority || fragment.authority || 'derived').toLowerCase() || 'derived';
    const nodes = Array.isArray(fragment.nodes) ? fragment.nodes : [];
    return {
      schemaVersion: KERNEL_SCHEMA_VERSION,
      collector,
      role,
      required,
      authority,
      sourcePriority: sourcePriority(collector, options.sourcePriority ?? fragment.sourcePriority),
      frameId: Number(options.frameId ?? fragment.frameId ?? 0),
      nodes,
      capabilities: [...new Set((fragment.capabilities || []).map(String))],
      diagnostics: Array.isArray(fragment.diagnostics) ? fragment.diagnostics : [],
      collection: normalizeCollection(fragment, options),
    };
  }

  function numberedRunSet(nodes = []) {
    const values = [...new Set(nodes.map((node) => {
      const type = core.normalizeText(node.type || node.kindHint || '').toLowerCase();
      if (/table|cell|code|control|input/.test(type)) return null;
      return core.extractLeadingNumber(evidenceLabel(node));
    }).filter((value) => Number.isFinite(Number(value)) && Number(value) >= 1 && Number(value) <= 10000).map(Number))].sort((a, b) => a - b);
    const promoted = new Set();
    let run = [];
    const commit = () => { if (run.length >= 3) for (const value of run) promoted.add(value); run = []; };
    for (const value of values) {
      if (!run.length || value === run.at(-1) + 1) run.push(value);
      else { commit(); run.push(value); }
    }
    commit();
    return promoted;
  }

  function promoteNumberedAnchor(node, runSet) {
    const label = evidenceLabel(node);
    const number = core.extractLeadingNumber(label);
    const type = core.normalizeText(node.type || node.kindHint || '').toLowerCase();
    if (!runSet.has(Number(number)) || /document_section|table|cell|code|control|input|collapsed_group/.test(type)) return node;
    return {
      ...node,
      type: 'document_section',
      role: node.role === 'heading' ? 'heading' : 'listitem',
      title: node.title || label,
      text: node.text || label,
      number: Number(number),
      attributes: { ...(node.attributes || {}), kernelPromotedNumberedBlock: true, sourceTypeBeforePromotion: type || null },
      confidence: Math.max(0.9, Number(node.confidence || 0)),
    };
  }

  function evidenceLabel(node) {
    return core.normalizeText(node.title || node.name || node.text || node.textPreview || node.role || node.type || '');
  }

  function evidenceKey(node, batch, index) {
    const sourceId = core.normalizeText(node.sourceId || node.locatorEvidence?.nativeId || node.evidence?.sourceId || '');
    const domPath = core.normalizeText(node.attributes?.domPath || node.locatorEvidence?.domPath || '');
    const label = evidenceLabel(node).toLowerCase();
    const number = Number.isFinite(Number(node.number)) ? Number(node.number) : core.extractLeadingNumber(label);
    const type = core.normalizeText(node.type || node.kindHint || 'node').toLowerCase();
    const frameId = Number(node.frameId ?? batch.frameId ?? 0);
    if (type === 'document') return `document:${frameId}`;
    if (type === 'collapsed_group') {
      const sig = core.normalizeText(node.collapsed?.signature || node.attributes?.signature || '');
      return `collapse:${frameId}:${sig}:${node.parentId || ''}`;
    }
    if (number !== null && /section|heading|listitem/.test(`${type} ${node.role || ''}`)) {
      return `numbered:${frameId}:${number}:${label.slice(0, 160)}`;
    }
    if (sourceId && !/^dom_|^ax_|^node$/i.test(sourceId)) return `native:${sourceId}`;
    if (domPath) return `dom:${frameId}:${domPath}`;
    if (label) {
      const bounds = Array.isArray(node.bounds) ? node.bounds.map((value) => Math.round(Number(value || 0) / 8)).join(',') : '';
      return `semantic:${frameId}:${type}:${label.slice(0, 180)}:${bounds}`;
    }
    return `unique:${batch.collector}:${frameId}:${sourceId || index}`;
  }

  function recordScore(record) {
    const primaryBonus = record.batch.role === 'primary' ? 40 : record.batch.role === 'supporting' ? 10 : 0;
    const authorityBonus = record.batch.authority === 'authoritative' ? 35 : record.batch.authority === 'derived' ? 15 : 0;
    return record.batch.sourcePriority + primaryBonus + authorityBonus + clamp(record.node.confidence, 0, 1, 0.8) * 20;
  }

  function mergeObject(primary, secondary) {
    return { ...(secondary && typeof secondary === 'object' ? secondary : {}), ...(primary && typeof primary === 'object' ? primary : {}) };
  }

  function mergeGroup(records, meta = {}) {
    const ranked = [...records].sort((a, b) => recordScore(b) - recordScore(a));
    const preferred = ranked[0];
    const merged = { ...preferred.node };
    const sources = [];
    const searchText = new Set(Array.isArray(merged.searchText) ? merged.searchText.map(String) : []);
    for (const record of ranked) {
      const node = record.node;
      sources.push({
        collector: record.batch.collector,
        role: record.batch.role,
        sourceId: node.sourceId || node.evidence?.sourceId || null,
        confidence: clamp(node.confidence, 0, 1, 0.8),
      });
      for (const value of [node.title, node.text, node.role, ...(node.searchText || [])]) {
        const normalized = core.normalizeText(value);
        if (normalized) searchText.add(normalized.slice(0, 240));
      }
      if (!merged.title && node.title) merged.title = node.title;
      if (!merged.text && node.text) merged.text = node.text;
      if (!merged.sourceId && node.sourceId) merged.sourceId = node.sourceId;
      if (!merged.parentId && node.parentId) merged.parentId = node.parentId;
      if (!merged.bounds && node.bounds) merged.bounds = node.bounds;
      if (!merged.locator && node.locator) merged.locator = node.locator;
      merged.attributes = mergeObject(merged.attributes, node.attributes);
      merged.locatorEvidence = mergeObject(merged.locatorEvidence, node.locatorEvidence);
      merged.flags = mergeObject(merged.flags, node.flags);
    }
    merged.adapter = preferred.batch.collector;
    merged.confidence = Math.max(...ranked.map((item) => clamp(item.node.confidence, 0, 1, 0.8)));
    merged.scopeHint = inferScopeHint(merged);
    merged.searchText = [...searchText].slice(0, 16);
    merged.evidence = {
      ...mergeObject(merged.evidence, {}),
      kernelSources: sources,
      primaryCollector: preferred.batch.collector,
      batchRole: preferred.batch.role,
      scopeHint: merged.scopeHint,
    };
    merged.id = merged.id || `ubm_${core.hashString(`${meta.url || ''}|${preferred.key}`)}`;
    return { node: merged, records: ranked };
  }

  function applyInheritedScopes(nodes = []) {
    const byId = new Map(nodes.filter((node) => node?.id).map((node) => [String(node.id), node]));
    const cache = new Map();
    const resolving = new Set();
    const resolve = (node) => {
      if (!node) return 'unknown';
      const key = node.id ? String(node.id) : null;
      if (key && cache.has(key)) return cache.get(key);
      if (key && resolving.has(key)) return inferScopeHint(node);
      if (key) resolving.add(key);
      const explicit = core.normalizeText(node.scopeHint || node.attributes?.scopeHint || node.evidence?.scopeHint).toLowerCase();
      let scope = ['content','chrome','navigation','decorative'].includes(explicit) ? explicit : 'unknown';
      const parent = node.parentId ? byId.get(String(node.parentId)) : null;
      const parentScope = parent ? resolve(parent) : 'unknown';
      if (parentScope === 'chrome' || parentScope === 'navigation') scope = parentScope;
      else if (scope === 'unknown') {
        scope = inferScopeHint(node);
        if (scope === 'unknown' && parentScope === 'content') scope = 'content';
      }
      if (key) { resolving.delete(key); cache.set(key, scope); }
      return scope;
    };
    return nodes.map((node) => ({ ...node, scopeHint: resolve(node), attributes: { ...(node.attributes || {}), scopeHint: resolve(node) } }));
  }

  function shouldIncludeSupportingNode(node, hasPrimaryContent) {
    if (!hasPrimaryContent) return true;
    const scope = inferScopeHint(node);
    if (scope === 'chrome' || scope === 'navigation' || scope === 'decorative') return false;
    const label = evidenceLabel(node);
    if ((node.type === 'image' || node.type === 'canvas_surface') && !label && !node.actionable) return false;
    return true;
  }

  function compactCollector(batch) {
    return {
      collector: batch.collector,
      role: batch.role,
      required: batch.required,
      authority: batch.authority,
      sourcePriority: batch.sourcePriority,
      frameId: batch.frameId,
      nodeCount: batch.nodes.length,
      collection: batch.collection,
    };
  }

  function coverageFromBatches(batches, nodeCount) {
    const nonEmpty = batches.filter((batch) => batch.nodes.length > 0 || batch.required);
    const explicitPrimary = nonEmpty.filter((batch) => batch.role === 'primary');
    const primary = explicitPrimary.length
      ? explicitPrimary
      : [...nonEmpty].sort((a, b) => b.sourcePriority - a.sourcePriority).slice(0, 1);
    const required = primary.filter((batch) => batch.required !== false);
    const requiredSet = required.length ? required : primary;
    const reasons = [];
    const warnings = [];
    if (!primary.length) reasons.push('primary_collector_missing');
    for (const batch of requiredSet) {
      if (!batch.collection.complete) {
        reasons.push(...(batch.collection.reasons.length ? batch.collection.reasons : [`${batch.collector}_collection_incomplete`]));
      }
    }
    for (const batch of batches) {
      warnings.push(...batch.collection.warnings.map((warning) => `${batch.collector}:${warning}`));
      if (batch.role !== 'primary' && !batch.collection.complete) {
        const issues = batch.collection.reasons.length ? batch.collection.reasons : [`${batch.collector}_supporting_incomplete`];
        warnings.push(...issues.map((issue) => `${batch.collector}:${issue}`));
      }
    }
    if (nodeCount === 0) reasons.push('navigation_nodes_empty');
    const uniqueReasons = [...new Set(reasons.filter(Boolean))].slice(0, 32);
    const uniqueWarnings = [...new Set(warnings.filter(Boolean))].slice(0, 32);
    const status = uniqueReasons.length ? 'incomplete' : uniqueWarnings.length ? 'complete_with_warnings' : 'complete';
    return {
      status,
      evidence: {
        primaryCollectors: primary.map((batch) => batch.collector),
        requiredCollectors: requiredSet.map((batch) => batch.collector),
        collectorCount: batches.length,
        nodeCount,
      },
      reasons: uniqueReasons,
      warnings: uniqueWarnings,
    };
  }

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

  function compileEvidenceBatches(inputBatches = [], meta = {}) {
    const batches = (inputBatches || [])
      .filter(Boolean)
      .map((batch) => batch.schemaVersion === KERNEL_SCHEMA_VERSION && Array.isArray(batch.nodes)
        ? { ...batch, collection: normalizeCollection(batch) }
        : evidenceBatchFromFragment(batch));
    const hasPrimaryContent = batches.some((batch) => batch.role === 'primary' && batch.nodes.length > 0);
    const records = [];
    // Per-stage trace: answers "at which stage did ordinal N disappear" without
    // re-scanning the page. Full trace stays in the persisted map / host logs.
    const batchTraces = [];
    for (const batch of batches) {
      const scopedNodes = applyInheritedScopes(batch.nodes);
      const runSet = numberedRunSet(scopedNodes);
      const numbersSeen = new Set();
      let droppedBySupportFilter = 0;
      scopedNodes.forEach((raw, index) => {
        const seen = core.extractLeadingNumber(evidenceLabel(raw));
        if (Number.isFinite(Number(seen)) && seen >= 1 && seen <= 10000) numbersSeen.add(Number(seen));
        const promoted = promoteNumberedAnchor(raw, runSet);
        if (batch.role !== 'primary' && !shouldIncludeSupportingNode(promoted, hasPrimaryContent)) { droppedBySupportFilter += 1; return; }
        const node = { ...promoted, frameId: promoted.frameId ?? batch.frameId, scopeHint: inferScopeHint(promoted) };
        records.push({ node, batch, index, key: evidenceKey(node, batch, index) });
      });
      batchTraces.push({ collector: batch.collector, role: batch.role, frameId: batch.frameId, nodesIn: batch.nodes.length, droppedBySupportFilter, numbersSeen: [...numbersSeen].sort((a, b) => a - b).slice(0, 512) });
    }

    const groups = new Map();
    for (const record of records) {
      if (!groups.has(record.key)) groups.set(record.key, []);
      groups.get(record.key).push(record);
    }

    const mergedGroups = [...groups.values()].map((group) => mergeGroup(group, meta));
    // Anchor ids must be unique map-wide: two evidence groups can inherit the
    // same collector node id when virtual remounts split one block across
    // groups; publication validation rejects duplicate ids.
    const usedNodeIds = new Set();
    for (const merged of mergedGroups) {
      let nodeId = String(merged.node.id);
      if (usedNodeIds.has(nodeId)) {
        nodeId = `ubm_${core.hashString(`${meta.url || ''}|${merged.records[0]?.key || nodeId}|${usedNodeIds.size}`)}`;
        merged.node.id = nodeId;
      }
      usedNodeIds.add(nodeId);
    }
    const rawIdToFinal = new Map();
    for (const merged of mergedGroups) {
      for (const record of merged.records) {
        if (record.node.id) rawIdToFinal.set(String(record.node.id), merged.node.id);
      }
    }
    const mergedNodes = mergedGroups.map(({ node }) => ({
      ...node,
      parentId: node.parentId ? rawIdToFinal.get(String(node.parentId)) || node.parentId : null,
      children: [],
    }));
    const budgetedNodes = applyAnchorBudget(mergedNodes, OUTPUT_NODE_BUDGET);

    const mapCoverage = coverageFromBatches(batches, budgetedNodes.length);
    const diagnostics = batches.flatMap((batch) => batch.diagnostics || []).slice(0, 80);
    const capabilities = [...new Set(batches.flatMap((batch) => batch.capabilities || []))];
    const map = core.buildMap([{ adapter: 'universal_map_kernel', nodes: budgetedNodes, diagnostics, capabilities }], {
      ...meta,
      completeness: {
        complete: mapCoverage.status !== 'incomplete',
        reasons: mapCoverage.reasons,
        warnings: mapCoverage.warnings,
      },
    });
    map.kernel = { schemaVersion: KERNEL_SCHEMA_VERSION, runtime: 'universal-map-kernel-v1' };
    map.mapCoverage = mapCoverage;
    map.collectors = batches.map(compactCollector);
    const numberedFinal = [...new Set(mergedNodes
      .filter((node) => core.normalizeText(node.type || '').toLowerCase() === 'document_section')
      .map((node) => Number.isFinite(Number(node.number)) ? Number(node.number) : core.extractLeadingNumber(evidenceLabel(node)))
      .filter((value) => Number.isFinite(Number(value)) && value >= 1 && value <= 10000)
      .map(Number))].sort((a, b) => a - b);
    const ordinalGaps = [];
    for (let value = numberedFinal[0] || 0; numberedFinal.length && value <= numberedFinal.at(-1) && ordinalGaps.length < 64; value += 1) {
      if (!numberedFinal.includes(value)) ordinalGaps.push(value);
    }
    map.kernelTrace = { batches: batchTraces, recordsTotal: records.length, mergedTotal: budgetedNodes.length, budgetApplied: budgetedNodes.length < mergedNodes.length, numberedFinal: numberedFinal.slice(0, 512), ordinalGaps };
    return map;
  }

  const api = {
    KERNEL_SCHEMA_VERSION,
    SOURCE_PRIORITY,
    inferScopeHint,
    evidenceBatchFromFragment,
    compileEvidenceBatches,
    coverageFromBatches,
    applyAnchorBudget,
  };

  global.ClaudeUniversalMapKernel = api;
})(globalThis);
