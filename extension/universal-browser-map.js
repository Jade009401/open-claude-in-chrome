(function (global) {
  'use strict';
  if (global.ClaudeUniversalBrowserMap) return;

  const core = global.ClaudeUniversalBrowserMapCore;
  const kernel = global.ClaudeUniversalMapKernel;
  if (!core) throw new Error('ClaudeUniversalBrowserMapCore is required');
  if (!kernel) throw new Error('ClaudeUniversalMapKernel is required');

  const state = { lastFragment: null, lastScanAt: 0 };

  function textOf(element) {
    if (!element) return '';
    const aria = element.getAttribute?.('aria-label') || element.getAttribute?.('title') || '';
    const text = element.innerText || element.textContent || '';
    return core.normalizeText(aria || text);
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function boundsOf(element) {
    try {
      const rect = element.getBoundingClientRect();
      return [Math.round(rect.left), Math.round(rect.top), Math.round(rect.right), Math.round(rect.bottom)];
    } catch { return null; }
  }

  function cssEscape(value) {
    if (global.CSS?.escape) return global.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
  }

  function segmentFor(element) {
    if (element.id) return `#${cssEscape(element.id)}`;
    const testId = element.getAttribute('data-testid');
    if (testId) return `${element.tagName.toLowerCase()}[data-testid="${String(testId).replace(/"/g, '\\"')}"]`;
    const role = element.getAttribute('role');
    const aria = element.getAttribute('aria-label');
    if (role && aria) return `${element.tagName.toLowerCase()}[role="${role}"][aria-label="${String(aria).replace(/"/g, '\\"')}"]`;
    const tag = element.tagName.toLowerCase();
    const parent = element.parentElement;
    if (!parent) return tag;
    const siblings = [...parent.children].filter((child) => child.tagName === element.tagName);
    const index = Math.max(1, siblings.indexOf(element) + 1);
    return siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag;
  }

  function domPath(element) {
    const groups = [];
    let current = element;
    let local = [];
    while (current && current.nodeType === 1) {
      local.unshift(segmentFor(current));
      const root = current.getRootNode();
      if (root instanceof ShadowRoot) {
        groups.unshift(local.join(' > '));
        local = [];
        current = root.host;
      } else {
        current = current.parentElement;
      }
    }
    if (local.length) groups.unshift(local.join(' > '));
    return groups.join(' >>> ');
  }

  function resolveDomPath(path) {
    if (!path) return null;
    const groups = String(path).split(/\s*>>>\s*/);
    let root = document;
    let found = null;
    for (let index = 0; index < groups.length; index += 1) {
      try { found = root.querySelector(groups[index]); } catch { return null; }
      if (!found) return null;
      if (index < groups.length - 1) root = found.shadowRoot;
      if (!root && index < groups.length - 1) return null;
    }
    return found;
  }

  function composedElements(root = document) {
    const output = [];
    const queue = [root];
    const seen = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      const children = current instanceof Document || current instanceof ShadowRoot
        ? [...current.children]
        : current instanceof Element ? [...current.children] : [];
      for (const child of children) {
        output.push(child);
        queue.push(child);
        if (child.shadowRoot) queue.push(child.shadowRoot);
      }
    }
    return output;
  }

  function roleOf(element) {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    return ({ a: 'link', button: 'button', input: 'textbox', textarea: 'textbox', select: 'combobox', table: 'table', tr: 'row', td: 'cell', th: 'columnheader', img: 'image', form: 'form', nav: 'navigation', main: 'main', aside: 'complementary', dialog: 'dialog', canvas: 'application' })[tag] || tag;
  }

  function scopeHintForElement(element) {
    let current = element;
    let contentSeen = false;
    for (let depth = 0; current && depth < 12; depth += 1, current = current.parentElement) {
      const role = roleOf(current);
      const tag = current.tagName?.toLowerCase?.() || '';
      if (role === 'navigation' || tag === 'nav') return 'navigation';
      if (['toolbar','banner','complementary','menubar','menu','status'].includes(role) || ['header','footer','aside'].includes(tag)) return 'chrome';
      if (['main','article','document'].includes(role) || ['main','article'].includes(tag) || current.getAttribute?.('contenteditable') === 'true') contentSeen = true;
    }
    return contentSeen ? 'content' : 'unknown';
  }

  function safeAttributes(element) {
    const keys = ['id', 'name', 'type', 'href', 'aria-label', 'aria-labelledby', 'aria-describedby', 'role', 'data-testid', 'data-node-id', 'contenteditable'];
    const attrs = {};
    for (const key of keys) {
      const value = element.getAttribute?.(key);
      if (value !== null && value !== '') attrs[key] = value;
    }
    attrs.domPath = domPath(element);
    attrs.tagName = element.tagName?.toLowerCase?.() || '';
    attrs.scopeHint = scopeHintForElement(element);
    return attrs;
  }

  function genericDomAdapter(options = {}) {
    const maxNodes = Math.max(100, Math.min(20000, Number(options.maxNodes || 6000)));
    const nodes = [];
    const elementIds = new WeakMap();
    const elements = composedElements(document);
    const semanticTags = new Set(['H1','H2','H3','H4','H5','H6','P','LI','A','BUTTON','INPUT','TEXTAREA','SELECT','FORM','NAV','MAIN','ASIDE','DIALOG','IMG','CANVAS','TABLE','TR','TD','TH','SUMMARY','DETAILS']);

    const add = (element, raw) => {
      if (nodes.length >= maxNodes) return null;
      const id = raw.id || `dom_${core.hashString(`${location.href}|${safeAttributes(element).domPath}|${nodes.length}`)}`;
      elementIds.set(element, id);
      const parent = element.parentElement;
      const parentId = parent ? elementIds.get(parent) || null : null;
      nodes.push({ id, parentId, frameId: 0, adapter: 'generic_dom', visible: isVisible(element), bounds: boundsOf(element), attributes: safeAttributes(element), ...raw });
      return id;
    };

    for (const element of elements) {
      const role = roleOf(element);
      const tag = element.tagName;
      const text = textOf(element);
      const isSemantic = semanticTags.has(tag) || element.hasAttribute('role') || element.hasAttribute('aria-label') || element.hasAttribute('data-testid');
      if (!isSemantic) continue;
      if (!text && !['INPUT','TEXTAREA','SELECT','CANVAS','IMG','TABLE','FORM'].includes(tag)) continue;
      if (tag === 'TR' || tag === 'TD' || tag === 'TH' || tag === 'TABLE') continue; // handled by table adapter
      const heading = /^H([1-6])$/.exec(tag);
      add(element, {
        type: heading ? 'document_section' : ['INPUT','TEXTAREA','SELECT','BUTTON','A'].includes(tag) ? 'control' : tag === 'CANVAS' ? 'canvas_surface' : tag === 'FORM' ? 'form' : tag === 'IMG' ? 'image' : 'dom_node',
        role,
        title: heading ? text : (element.getAttribute('aria-label') || element.getAttribute('name') || ''),
        text,
        level: heading ? Number(heading[1]) : undefined,
        number: heading ? core.extractLeadingNumber(text) : null,
        actionable: ['button','link','textbox','combobox','checkbox','radio'].includes(role),
        opaque: tag === 'CANVAS',
        confidence: heading ? 0.96 : 0.8,
      });
    }
    const truncated = nodes.length >= maxNodes;
    return { adapter: 'generic_dom', nodes, capabilities: ['dom', 'shadow_dom', 'semantic_elements', 'controls'], collection: { status: truncated ? 'truncated' : 'snapshot_complete', frontier: 'snapshot_complete', truncated, limitReached: truncated, unresolvedRegions: 0, nodeCount: nodes.length, reasons: truncated ? ['generic_dom_node_limit_reached'] : [] } };
  }

  function documentAdapter(options = {}) {
    const blocks = [];
    const elements = composedElements(document);
    for (const element of elements) {
      const tag = element.tagName;
      const heading = /^H([1-6])$/.exec(tag);
      const role = element.getAttribute('role');
      if (!heading && !['P','LI','BLOCKQUOTE','PRE'].includes(tag) && !['heading','paragraph','listitem'].includes(role)) continue;
      const text = textOf(element);
      if (!text) continue;
      blocks.push({
        type: heading ? `heading${heading[1]}` : role === 'heading' ? `heading${element.getAttribute('aria-level') || 2}` : tag === 'LI' ? 'list_item' : tag === 'BLOCKQUOTE' ? 'quote' : 'paragraph',
        text,
        sourceId: element.id || element.getAttribute('data-block-id') || element.getAttribute('data-node-id') || domPath(element),
        virtualTop: Math.round(element.getBoundingClientRect().top + scrollY),
        attributes: { domPath: domPath(element) },
      });
    }
    if (!blocks.some((block) => /^heading/.test(block.type))) return { adapter: 'document_dom', nodes: [], capabilities: [], collection: { status: 'snapshot_complete', frontier: 'snapshot_complete', unresolvedRegions: 0, nodeCount: 0 } };
    const fragment = core.buildDocumentNodes(blocks, { title: document.title, url: location.href, adapter: 'document_dom' });
    fragment.collection = { status: 'snapshot_complete', frontier: 'snapshot_complete', unresolvedRegions: 0, nodeCount: fragment.nodes.length };
    return fragment;
  }

  function tableAdapter() {
    const tables = [];
    const tableElements = [...document.querySelectorAll('table,[role="table"],[role="grid"],[role="treegrid"]')];
    tableElements.forEach((tableElement, tableIndex) => {
      const headerEls = [...tableElement.querySelectorAll('thead th,[role="columnheader"]')];
      const headers = headerEls.map(textOf);
      const rowEls = [...tableElement.querySelectorAll('tbody tr,[role="row"]')].filter((row) => !headerEls.includes(row));
      const rows = rowEls.map((row, rowIndex) => {
        const cellEls = [...row.querySelectorAll(':scope > th,:scope > td,[role="gridcell"],[role="cell"]')];
        const cells = cellEls.map(textOf);
        const values = Object.fromEntries(cells.map((value, cellIndex) => [headers[cellIndex] || `column_${cellIndex + 1}`, value]));
        return { rowIndex, cells, values, text: cells.join(' | '), key: row.getAttribute('data-row-key') || values.id || values.uid || row.getAttribute('aria-rowindex') || cells[0] || `row-${rowIndex + 1}`, sourceId: domPath(row), actionable: Boolean(row.querySelector('button,a,input,select')) };
      });
      tables.push({ tableIndex: tableIndex + 1, title: tableElement.getAttribute('aria-label') || tableElement.querySelector('caption')?.textContent || `Table ${tableIndex + 1}`, headers, rows });
    });

    const virtualModels = Array.isArray(global.__CLAUDE_VIRTUAL_TABLES__) ? global.__CLAUDE_VIRTUAL_TABLES__ : [];
    for (const model of virtualModels) tables.push(model);
    const fragment = core.buildTableNodes(tables, { url: location.href, adapter: virtualModels.length ? 'virtual_table' : 'table_dom' });
    fragment.collection = { status: 'snapshot_complete', frontier: 'snapshot_complete', unresolvedRegions: 0, nodeCount: fragment.nodes.length };
    return fragment;
  }

  function figmaAdapter() {
    const isFigma = /(^|\.)figma\.com$/i.test(location.hostname) || document.documentElement.dataset.claudeFixture === 'figma';
    if (!isFigma) return { adapter: 'figma', nodes: [], capabilities: [], collection: { status: 'snapshot_complete', frontier: 'snapshot_complete', unresolvedRegions: 0, nodeCount: 0 } };
    const canvases = [...document.querySelectorAll('canvas')];
    const sceneModel = Array.isArray(global.__CLAUDE_FIGMA_SCENE__) ? global.__CLAUDE_FIGMA_SCENE__ : [];
    const treeItems = [...document.querySelectorAll('[role="treeitem"],[data-node-id]')].slice(0, 5000).map((element, index) => ({
      id: element.getAttribute('data-node-id') || element.id || `layer-${index + 1}`,
      name: textOf(element) || `Layer ${index + 1}`,
      type: element.getAttribute('data-node-type') || element.getAttribute('role') || 'layer',
      role: element.getAttribute('role') || 'treeitem',
      bounds: boundsOf(element),
      actionable: true,
      attributes: safeAttributes(element),
      evidence: { source: 'layers_or_accessibility' },
    }));
    const sceneNodes = [...sceneModel, ...treeItems];
    const surfaces = (canvases.length ? canvases : [document.documentElement]).map((canvas, index) => ({
      canvasIndex: index + 1,
      name: canvas.getAttribute?.('aria-label') || 'Figma canvas',
      application: 'figma',
      adapter: 'figma',
      bounds: canvas === document.documentElement ? null : boundsOf(canvas),
      opaque: sceneNodes.length === 0,
      sceneNodes: index === 0 ? sceneNodes : [],
      attributes: canvas === document.documentElement ? {} : safeAttributes(canvas),
      evidence: { sceneSource: sceneModel.length ? 'application_model' : treeItems.length ? 'layers_or_accessibility' : 'opaque_canvas' },
    }));
    const fragment = core.buildCanvasNodes(surfaces, { url: location.href, pageType: 'figma' });
    fragment.collection = { status: 'snapshot_complete', frontier: 'snapshot_complete', unresolvedRegions: 0, nodeCount: fragment.nodes.length, warnings: sceneNodes.length ? [] : ['opaque_surface_present'] };
    return fragment;
  }

  function spreadsheetAdapter() {
    const model = global.__CLAUDE_SHEET_MODEL__;
    const grids = [...document.querySelectorAll('[role="grid"],[role="treegrid"]')];
    if (!model && !grids.length && !/sheets|spreadsheet|excel/i.test(`${location.href} ${document.title}`)) return { adapter: 'spreadsheet', nodes: [], capabilities: [], collection: { status: 'snapshot_complete', frontier: 'snapshot_complete', unresolvedRegions: 0, nodeCount: 0 } };
    const nodes = [];
    const sheetName = core.normalizeText(model?.name || document.querySelector('[aria-label*="sheet" i]')?.textContent || 'Sheet1');
    const sheetId = `sheet_${core.hashString(`${location.href}|${sheetName}`)}`;
    nodes.push({ id: sheetId, type: 'sheet', role: 'grid', name: sheetName, title: sheetName, adapter: 'spreadsheet', confidence: 0.95 });
    const cells = Array.isArray(model?.cells) ? model.cells : [...document.querySelectorAll('[role="gridcell"]')].map((element, index) => ({ address: element.getAttribute('data-cell') || element.getAttribute('aria-label') || `R${element.getAttribute('aria-rowindex') || 1}C${element.getAttribute('aria-colindex') || index + 1}`, value: textOf(element), bounds: boundsOf(element), attributes: safeAttributes(element) }));
    for (const cell of cells.slice(0, 20000)) {
      nodes.push({ parentId: sheetId, type: 'sheet_cell', role: 'gridcell', sheetName, cellAddress: cell.address || cell.name, name: cell.address || cell.name, title: cell.address || cell.name, text: core.normalizeText(cell.value), bounds: cell.bounds || null, attributes: cell.attributes || {}, adapter: 'spreadsheet', confidence: 0.94, materialized: cell.materialized !== false });
    }
    return { adapter: 'spreadsheet', nodes, capabilities: ['spreadsheet', 'sheet_cells', ...(model ? ['application_model'] : ['aria_grid'])], collection: { status: 'snapshot_complete', frontier: 'snapshot_complete', unresolvedRegions: 0, nodeCount: nodes.length, warnings: model ? [] : ['viewport_grid_only'] } };
  }

  function virtualDocumentAdapter() {
    const model = global.__CLAUDE_VIRTUAL_DOCUMENT__;
    if (!model || !Array.isArray(model.blocks)) return { adapter: 'virtual_document', nodes: [], capabilities: [], collection: { status: 'snapshot_complete', frontier: 'snapshot_complete', unresolvedRegions: 0, nodeCount: 0 } };
    const fragment = core.buildDocumentNodes(model.blocks, { title: model.title || document.title, url: location.href, adapter: 'virtual_document' });
    fragment.collection = { status: model.complete === false ? 'incomplete' : 'authoritative_complete', frontier: model.complete === false ? 'unknown' : 'authoritative_complete', unresolvedRegions: Number(model.unresolvedRegions || 0), nodeCount: fragment.nodes.length, reasons: model.complete === false ? ['virtual_document_incomplete'] : [] };
    return fragment;
  }

  function scan(options = {}) {
    const fragments = [virtualDocumentAdapter(), documentAdapter(options), tableAdapter(options), spreadsheetAdapter(options), figmaAdapter(options), genericDomAdapter(options)];
    const nodes = [];
    const capabilities = new Set();
    const diagnostics = [];
    const seen = new Set();
    const evidenceBatches = [];
    for (const fragment of fragments) {
      evidenceBatches.push(kernel.evidenceBatchFromFragment(fragment, { collector: fragment.adapter, role: 'supporting', authority: fragment.adapter === 'virtual_document' ? 'authoritative' : 'derived' }));
      for (const capability of fragment.capabilities || []) capabilities.add(capability);
      for (const diagnostic of fragment.diagnostics || []) diagnostics.push(diagnostic);
      for (const node of fragment.nodes || []) {
        const key = `${node.type}|${node.sourceId || node.attributes?.domPath || ''}|${node.text || ''}|${node.title || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        nodes.push(node);
      }
    }
    const pageType = core.detectPageType({ url: location.href, title: document.title, nodes });
    const warnings = nodes.some((node) => node.opaque) ? ['opaque_surface_present'] : [];
    const fragment = { ok: true, adapter: 'universal_page', pageType, title: document.title, url: location.href, nodes: options.evidenceOnly === true ? [] : nodes, evidenceBatches, capabilities: [...capabilities], diagnostics, collection: { status: 'snapshot_complete', frontier: 'snapshot_complete', unresolvedRegions: 0, nodeCount: nodes.length, warnings }, completeness: { complete: true, reasons: [], warnings } };
    state.lastFragment = fragment;
    state.lastScanAt = Date.now();
    return fragment;
  }

  function findNode(target) {
    const fragment = state.lastFragment || scan({});
    const value = String(target?.locator || target?.id || target || '');
    return fragment.nodes.find((node) => node.id === value || node.locator === value) || null;
  }

  function act(target, action, value) {
    const node = findNode(target);
    if (!node) return { ok: false, code: 'locator_not_found' };
    const path = node.attributes?.domPath;
    const element = resolveDomPath(path);
    if (!element) return { ok: false, code: node.opaque ? 'opaque_surface_not_directly_actionable' : 'dom_target_not_materialized', locator: node.locator };
    if (action === 'scroll_into_view') { element.scrollIntoView({ block: 'center', inline: 'nearest' }); return { ok: true, locator: node.locator }; }
    if (action === 'click') { element.click(); return { ok: true, locator: node.locator }; }
    if (action === 'focus') { element.focus(); return { ok: true, locator: node.locator }; }
    if (action === 'input') {
      if (!('value' in element)) return { ok: false, code: 'target_not_input' };
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
      if (setter) setter.call(element, value); else element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, locator: node.locator };
    }
    return { ok: false, code: 'unsupported_action', action };
  }

  global.ClaudeUniversalBrowserMap = { scan, act, resolveDomPath, state };
})(globalThis);
