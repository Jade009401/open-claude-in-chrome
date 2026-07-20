(function(global){

const MAP_SCHEMA_VERSION = 1;

function normalizeText(value) {
  return String(value ?? '').replace(/\u200B|\u200C|\u200D|\uFEFF/g, '').replace(/\s+/g, ' ').trim();
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value ?? '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function escapeLocatorValue(value) {
  return normalizeText(value).replace(/\\/g, '\\\\').replace(/\]/g, '\\]').replace(/"/g, '\\"').slice(0, 180);
}

function extractLeadingNumber(text) {
  // Three shapes: "（25）标题"/"(25) 标题"; "25）标题"/"25) 标题"; "25. 标题"/"25、"/"第25条".
  // Paren-closed forms need no trailing separator; the bare form still does. The bare form
  // excludes times ("16:03:39" — ":" is not an ordinal separator) and decimals/thousands
  // ("20.070"/"2,000" — a digit followed by [.,]digit is a value, not an ordinal).
  const match = normalizeText(text).match(/^(?:[（(]\s*(\d{1,5})\s*[)）]|(\d{1,5})\s*[)）]|(?:第\s*)?(\d{1,5})(?![.,]\d)(?:\s*条)?(?:[.、\s-]+|$))/);
  return match ? Number(match[1] ?? match[2] ?? match[3]) : null;
}

function semanticKey(node) {
  return normalizeText(node.semanticKey || node.sourceId || node.key || node.name || node.title || node.text || node.role || node.type || 'node');
}

function defaultLocator(node, meta = {}) {
  if (node.locator) return String(node.locator);
  const title = normalizeText(node.title || node.name || node.text);
  const number = node.number !== null && node.number !== undefined && Number.isFinite(Number(node.number)) ? Number(node.number) : extractLeadingNumber(title);
  if (node.type === 'document') return 'document:root';
  if (node.type === 'document_section') {
    if (number !== null) return `document:section[number=${number}]`;
    return `document:section[title="${escapeLocatorValue(title)}"]`;
  }
  if (node.type === 'document_block') {
    const section = node.sectionNumber !== undefined && node.sectionNumber !== null ? `[section=${node.sectionNumber}]` : '';
    return `document:block${section}[key="${escapeLocatorValue(semanticKey(node))}"]`;
  }
  if (node.type === 'table') return `table[index=${Number(node.tableIndex || 1)}]`;
  if (node.type === 'table_row') return `table[index=${Number(node.tableIndex || 1)}]/row[key="${escapeLocatorValue(node.rowKey || semanticKey(node))}"]`;
  if (node.type === 'table_cell') return `table[index=${Number(node.tableIndex || 1)}]/row[key="${escapeLocatorValue(node.rowKey || 'row')}"]/cell[column="${escapeLocatorValue(node.column || node.name || 'cell')}"]`;
  if (node.type === 'form') return `form[index=${Number(node.formIndex || 1)}]`;
  if (node.type === 'control') return `form[index=${Number(node.formIndex || 1)}]/control[name="${escapeLocatorValue(node.name || node.title || node.role || semanticKey(node))}"]`;
  if (node.type === 'figma_canvas') return 'application:figma/canvas[main]';
  if (node.type === 'figma_node') return `application:figma/node[key="${escapeLocatorValue(node.sourceId || semanticKey(node))}"]`;
  if (node.type === 'sheet') return `workbook:sheet[name="${escapeLocatorValue(node.name || title || 'Sheet1')}"]`;
  if (node.type === 'sheet_cell') return `workbook:sheet[name="${escapeLocatorValue(node.sheetName || 'Sheet1')}"]/cell[${escapeLocatorValue(node.cellAddress || node.name || semanticKey(node))}]`;
  if (node.type === 'canvas_surface') return `canvas[index=${Number(node.canvasIndex || 1)}]`;
  const page = meta.pageId || meta.tabId || 'current';
  const frame = node.frameId ?? meta.frameId ?? 0;
  const role = normalizeText(node.role || node.type || 'node').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return `page[${escapeLocatorValue(page)}]/frame[${frame}]/${role}[key="${escapeLocatorValue(semanticKey(node))}"]`;
}

function normalizeNode(raw, index, meta = {}) {
  const node = { ...raw };
  node.type = normalizeText(node.type || 'node') || 'node';
  node.role = normalizeText(node.role || node.type) || node.type;
  node.title = normalizeText(node.title || node.name || '');
  node.text = normalizeText(node.text || node.textPreview || '');
  node.number = node.number !== null && node.number !== undefined && Number.isFinite(Number(node.number)) ? Number(node.number) : extractLeadingNumber(node.title || node.text);
  node.frameId = node.frameId ?? meta.frameId ?? 0;
  node.adapter = node.adapter || meta.adapter || 'generic_dom';
  node.locator = defaultLocator(node, meta);
  node.id = node.id || `ubm_${hashString(`${node.locator}|${node.frameId}|${node.sourceId || ''}|${index}`)}`;
  node.parentId = node.parentId || null;
  node.children = Array.isArray(node.children) ? [...node.children] : [];
  node.attributes = node.attributes && typeof node.attributes === 'object' ? node.attributes : {};
  node.bounds = Array.isArray(node.bounds) ? node.bounds.map(Number) : null;
  node.visible = node.visible !== false;
  node.materialized = node.materialized !== false;
  node.opaque = node.opaque === true;
  node.actionable = node.actionable === true;
  node.confidence = Math.max(0, Math.min(1, Number(node.confidence ?? 0.8)));
  node.evidence = node.evidence && typeof node.evidence === 'object' ? node.evidence : {};
  return node;
}

function buildMap(adapterResults = [], meta = {}) {
  const rawNodes = [];
  const diagnostics = [];
  const capabilities = new Set();
  for (const result of adapterResults || []) {
    if (!result) continue;
    if (Array.isArray(result)) rawNodes.push(...result);
    else {
      if (Array.isArray(result.nodes)) rawNodes.push(...result.nodes.map((node) => ({ ...node, adapter: node.adapter || result.adapter })));
      for (const item of result.diagnostics || []) diagnostics.push(item);
      for (const capability of result.capabilities || []) capabilities.add(capability);
    }
  }
  const nodes = rawNodes.map((node, index) => normalizeNode(node, index, meta));
  const byId = new Map();
  const locatorCounts = new Map();
  for (const node of nodes) {
    const count = locatorCounts.get(node.locator) || 0;
    locatorCounts.set(node.locator, count + 1);
    if (count > 0) node.locator = `${node.locator}[occurrence=${count + 1}]`;
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    if (node.parentId && byId.has(node.parentId)) {
      const parent = byId.get(node.parentId);
      if (!parent.children.includes(node.id)) parent.children.push(node.id);
    }
  }
  const mapId = meta.mapId || `map_${hashString(`${meta.url || ''}|${meta.title || ''}|${Date.now()}|${nodes.length}`)}`;
  return {
    ok: true,
    schemaVersion: MAP_SCHEMA_VERSION,
    mapId,
    createdAt: new Date().toISOString(),
    page: {
      tabId: meta.tabId ?? null,
      pageId: meta.pageId || null,
      title: normalizeText(meta.title),
      url: String(meta.url || ''),
      pageType: meta.pageType || detectPageType({ title: meta.title, url: meta.url, nodes }),
    },
    nodes,
    nodeCount: nodes.length,
    rootNodeIds: nodes.filter((node) => !node.parentId || !byId.has(node.parentId)).map((node) => node.id),
    capabilities: [...capabilities],
    diagnostics,
    completeness: meta.completeness || { complete: true, reasons: [] },
  };
}

function detectPageType(input = {}) {
  const text = `${input.url || ''} ${input.title || ''}`.toLowerCase();
  const nodes = input.nodes || [];
  if (/figma\.com/.test(text) || nodes.some((node) => node.type === 'figma_canvas')) return 'figma';
  if (/(?:larksuite|feishu)\.com/.test(text) || nodes.some((node) => node.type === 'document_section')) return 'document';
  if (nodes.some((node) => node.type === 'sheet' || node.type === 'sheet_cell')) return 'spreadsheet';
  if (nodes.some((node) => node.type === 'table_row')) return 'data_application';
  if (nodes.some((node) => node.type === 'canvas_surface')) return 'canvas_application';
  return 'web_page';
}

function textScore(node, query, options = {}) {
  const q = normalizeText(query);
  if (!q) return 0;
  const caseSensitive = options.caseSensitive === true;
  const needle = caseSensitive ? q : q.toLowerCase();
  const title = caseSensitive ? node.title : node.title.toLowerCase();
  const text = caseSensitive ? node.text : node.text.toLowerCase();
  const locator = caseSensitive ? node.locator : node.locator.toLowerCase();
  let score = 0;
  if (locator === needle) score += 10000;
  if (node.id === q) score += 10000;
  if (title === needle) score += 1200;
  else if (title.startsWith(needle)) score += 700;
  else if (title.includes(needle)) score += 450;
  if (text === needle) score += 800;
  else if (text.startsWith(needle)) score += 420;
  else if (text.includes(needle)) score += 260;
  const requestedNumber = extractLeadingNumber(q) ?? (/^\d+$/.test(q) ? Number(q) : null);
  if (requestedNumber !== null && node.number === requestedNumber) score += 1500;
  if (options.types?.length && options.types.includes(node.type)) score += 300;
  if (node.visible) score += 15;
  if (node.materialized) score += 10;
  if (node.opaque) score -= 30;
  score += node.confidence * 20;
  return score;
}

function locate(map, query, options = {}) {
  if (!map?.nodes) return { ok: false, code: 'map_required' };
  const q = normalizeText(query || options.locator || options.id);
  const requestedTypes = Array.isArray(options.types) ? options.types : [];
  let candidates = map.nodes;
  if (requestedTypes.length) candidates = candidates.filter((node) => requestedTypes.includes(node.type));
  const ranked = candidates
    .map((node) => ({ node, score: textScore(node, q, { ...options, types: requestedTypes }) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.node.confidence - a.node.confidence)
    .slice(0, Math.max(1, Math.min(50, Number(options.limit || 10))));
  return {
    ok: true,
    found: ranked.length > 0,
    query: q,
    mapId: map.mapId,
    matches: ranked.map(({ node, score }) => ({
      id: node.id,
      locator: node.locator,
      type: node.type,
      role: node.role,
      title: node.title,
      textPreview: node.text.slice(0, 500),
      score,
      confidence: node.confidence,
      frameId: node.frameId,
      adapter: node.adapter,
      visible: node.visible,
      materialized: node.materialized,
      opaque: node.opaque,
      bounds: node.bounds,
      evidence: node.evidence,
    })),
  };
}

function resolveNode(map, target) {
  if (!map?.nodes) return null;
  const value = normalizeText(typeof target === 'string' ? target : target?.locator || target?.id);
  if (!value) return null;
  return map.nodes.find((node) => node.id === value || node.locator === value) || null;
}

function read(map, target, options = {}) {
  const node = resolveNode(map, target);
  if (!node) return { ok: false, code: 'locator_not_found', mapId: map?.mapId || null, target };
  const byId = new Map(map.nodes.map((item) => [item.id, item]));
  const depth = Math.max(0, Math.min(8, Number(options.depth ?? 3)));
  const maxNodes = Math.max(1, Math.min(1000, Number(options.maxNodes || 200)));
  const maxChars = Math.max(100, Math.min(500000, Number(options.maxChars || 100000)));
  const output = [];
  let chars = 0;
  const visit = (current, level) => {
    if (!current || output.length >= maxNodes || chars >= maxChars) return;
    const copy = {
      id: current.id,
      locator: current.locator,
      type: current.type,
      role: current.role,
      title: current.title,
      text: current.text,
      attributes: current.attributes,
      bounds: current.bounds,
      visible: current.visible,
      materialized: current.materialized,
      opaque: current.opaque,
      actionable: current.actionable,
      adapter: current.adapter,
      frameId: current.frameId,
      confidence: current.confidence,
      evidence: current.evidence,
      level,
    };
    const serialized = JSON.stringify(copy);
    if (chars + serialized.length > maxChars && output.length) return;
    output.push(copy);
    chars += serialized.length;
    if (level >= depth) return;
    for (const childId of current.children || []) visit(byId.get(childId), level + 1);
  };
  visit(node, 0);
  return {
    ok: true,
    mapId: map.mapId,
    target: { id: node.id, locator: node.locator },
    nodes: output,
    returnedNodeCount: output.length,
    truncated: output.length >= maxNodes || chars >= maxChars,
    source: map.page,
    completeness: map.completeness,
  };
}

function buildDocumentNodes(blocks = [], meta = {}) {
  const nodes = [];
  const rootId = `doc_${hashString(meta.url || meta.title || 'document')}`;
  nodes.push({ id: rootId, type: 'document', role: 'document', title: meta.title || '', text: '', adapter: meta.adapter || 'document', sourceId: meta.sourceId || null, confidence: 1 });

  // Lark requirement lists are not always real heading elements. Detect stable
  // consecutive numbered runs so a tail item such as "25. ..." remains a
  // document_section even when the editor emits it as a paragraph/list block.
  const distinctNumbers = [...new Set((blocks || [])
    .map((block) => extractLeadingNumber(normalizeText(block?.text)))
    .filter((value) => Number.isFinite(Number(value)) && Number(value) >= 1 && Number(value) <= 10000)
    .map(Number))].sort((a, b) => a - b);
  const numberedSectionNumbers = new Set();
  let run = [];
  const commitRun = () => {
    if (run.length >= 3) for (const value of run) numberedSectionNumbers.add(value);
    run = [];
  };
  for (const value of distinctNumbers) {
    if (!run.length || value === run.at(-1) + 1) run.push(value);
    else { commitRun(); run.push(value); }
  }
  commitRun();

  const sectionStack = [];
  let currentSectionId = rootId;
  let sectionNumber = null;
  blocks.forEach((block, index) => {
    const type = normalizeText(block.type || 'paragraph').toLowerCase();
    const text = normalizeText(block.text);
    const headingMatch = type.match(/heading(\d+)/) || (block.level ? ['', String(block.level)] : null);
    const leadingNumber = extractLeadingNumber(text);
    const numberedStructure = leadingNumber !== null
      && numberedSectionNumbers.has(Number(leadingNumber))
      && !['tablecell', 'table', 'code'].includes(type);
    if (headingMatch || numberedStructure) {
      const level = headingMatch ? Number(headingMatch[1] || block.level || 1) : Math.max(1, Math.min(6, Number(block.level || 2)));
      while (sectionStack.length && sectionStack.at(-1).level >= level) sectionStack.pop();
      const parentId = sectionStack.length ? sectionStack.at(-1).id : rootId;
      const id = `sec_${hashString(`${block.sourceId || index}|${text}`)}`;
      sectionNumber = leadingNumber;
      nodes.push({ id, parentId, type: 'document_section', role: headingMatch ? 'heading' : 'listitem', title: text, text, level, number: sectionNumber, sourceId: block.sourceId || null, adapter: meta.adapter || 'document', confidence: headingMatch ? 0.98 : 0.96, attributes: { sourceBlockType: type, promotedNumberedBlock: !headingMatch }, evidence: { ordinal: block.ordinal ?? index, sectionPath: block.sectionPath || block.path || null, sourceBlockType: type, virtualTop: Number.isFinite(block.virtualTop) ? block.virtualTop : null } });
      sectionStack.push({ id, level });
      currentSectionId = id;
    } else {
      const id = `blk_${hashString(`${block.sourceId || index}|${text}`)}`;
      nodes.push({ id, parentId: currentSectionId, type: 'document_block', role: type, text, title: '', sectionNumber, sourceId: block.sourceId || null, adapter: meta.adapter || 'document', confidence: 0.92, attributes: { ordinal: block.ordinal ?? index, blockType: type }, evidence: { ordinal: block.ordinal ?? index, sourceId: block.sourceId || null, sectionTitle: block.sectionTitle || null, virtualTop: Number.isFinite(block.virtualTop) ? block.virtualTop : null } });
    }
  });
  return { adapter: meta.adapter || 'document', nodes, capabilities: ['document_sections', 'document_blocks', 'stable_section_locators'] };
}

function buildTableNodes(tables = [], meta = {}) {
  const nodes = [];
  tables.forEach((table, tableOffset) => {
    const tableIndex = Number(table.tableIndex || tableOffset + 1);
    const tableId = `tbl_${hashString(`${meta.url || ''}|${tableIndex}|${table.title || ''}`)}`;
    nodes.push({ id: tableId, type: 'table', role: 'table', title: table.title || `Table ${tableIndex}`, text: '', tableIndex, adapter: meta.adapter || 'table', confidence: 0.95 });
    const headers = table.headers || [];
    (table.rows || []).forEach((row, rowIndex) => {
      const rowText = normalizeText(row.text || (row.cells || []).join(' | ') || Object.values(row.values || {}).join(' | '));
      const rowKey = normalizeText(row.key || row.sourceId || row.values?.id || row.values?.uid || rowText || `row-${rowIndex + 1}`);
      const rowId = `row_${hashString(`${tableId}|${rowKey}`)}`;
      nodes.push({ id: rowId, parentId: tableId, type: 'table_row', role: 'row', text: rowText, tableIndex, rowKey, sourceId: row.sourceId || null, adapter: meta.adapter || 'table', confidence: 0.93, attributes: { rowIndex: row.rowIndex ?? rowIndex, values: row.values || null }, actionable: Boolean(row.actionable) });
      const values = row.values || Object.fromEntries((row.cells || []).map((value, cellIndex) => [headers[cellIndex] || `column_${cellIndex + 1}`, value]));
      Object.entries(values).forEach(([column, value]) => {
        nodes.push({ parentId: rowId, type: 'table_cell', role: 'cell', text: normalizeText(value), title: normalizeText(column), tableIndex, rowKey, column, adapter: meta.adapter || 'table', confidence: 0.95 });
      });
    });
  });
  return { adapter: meta.adapter || 'table', nodes, capabilities: ['tables', 'rows', 'cells', 'stable_row_locators'] };
}

function buildCanvasNodes(surfaces = [], meta = {}) {
  const nodes = [];
  surfaces.forEach((surface, index) => {
    const canvasIndex = Number(surface.canvasIndex || index + 1);
    const isFigma = surface.application === 'figma' || meta.pageType === 'figma';
    const id = `canvas_${hashString(`${meta.url || ''}|${canvasIndex}|${surface.name || ''}`)}`;
    nodes.push({ id, type: isFigma ? 'figma_canvas' : 'canvas_surface', role: 'application', title: surface.name || (isFigma ? 'Figma canvas' : `Canvas ${canvasIndex}`), text: surface.description || '', canvasIndex, adapter: surface.adapter || (isFigma ? 'figma' : 'canvas'), bounds: surface.bounds || null, opaque: surface.opaque !== false && !(surface.sceneNodes || []).length, confidence: surface.confidence ?? 0.8, attributes: surface.attributes || {}, evidence: surface.evidence || {} });
    for (const scene of surface.sceneNodes || []) {
      nodes.push({ parentId: id, type: isFigma ? 'figma_node' : 'canvas_node', role: scene.role || scene.type || 'node', title: scene.name || scene.title || '', text: scene.text || '', sourceId: scene.id || scene.sourceId || null, adapter: surface.adapter || (isFigma ? 'figma' : 'canvas'), bounds: scene.bounds || null, confidence: scene.confidence ?? 0.9, actionable: scene.actionable === true, attributes: scene.attributes || {}, evidence: scene.evidence || {} });
    }
  });
  return { adapter: meta.pageType === 'figma' ? 'figma' : 'canvas', nodes, capabilities: ['canvas_surfaces', ...(nodes.some((node) => node.type === 'figma_node' || node.type === 'canvas_node') ? ['canvas_semantic_nodes'] : ['opaque_canvas_detection'])] };
}

function mergeMaps(maps = [], meta = {}) {
  const results = maps.filter(Boolean).map((map) => ({ adapter: map.page?.pageType || 'map', nodes: map.nodes || [], diagnostics: map.diagnostics || [], capabilities: map.capabilities || [] }));
  const completeness = maps.reduce((acc, map) => ({ complete: acc.complete && map?.completeness?.complete !== false, reasons: [...acc.reasons, ...(map?.completeness?.reasons || [])] }), { complete: true, reasons: [] });
  return buildMap(results, { ...meta, completeness });
}

const api = {
  MAP_SCHEMA_VERSION,
  normalizeText,
  hashString,
  extractLeadingNumber,
  defaultLocator,
  normalizeNode,
  buildMap,
  detectPageType,
  locate,
  read,
  resolveNode,
  buildDocumentNodes,
  buildTableNodes,
  buildCanvasNodes,
  mergeMaps,
};

global.ClaudeUniversalBrowserMapCore = api;
})(globalThis);
