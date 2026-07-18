/* Structured read-only reader for modern Web apps, management consoles and virtual data surfaces. */
((root) => {
  const core = root.OpenClaudeWebAppCore;
  const normalize = core?.normalizeText || ((value) => String(value || '').trim());
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function rendered(node) {
    if (!(node instanceof HTMLElement || node instanceof SVGElement)) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
  }

  function textOf(node) { return normalize(node?.innerText || node?.textContent || ''); }
  function sourceIdOf(node) {
    return node?.getAttribute?.('data-row-key')
      || node?.getAttribute?.('data-key')
      || node?.getAttribute?.('data-uid')
      || node?.getAttribute?.('data-id')
      || node?.getAttribute?.('data-testid')
      || node?.id
      || null;
  }
  function absoluteHref(node) {
    try { return node?.href ? new URL(node.href, location.href).href : ''; } catch { return ''; }
  }
  function escapeCss(value) {
    try { return CSS.escape(String(value)); } catch { return String(value).replace(/[^A-Za-z0-9_-]/g, '\\$&'); }
  }

  function visibleControls(limit = 100) {
    const selector = 'input,select,textarea,button,[role="combobox"],[role="searchbox"],[role="tab"],[role="switch"],[aria-pressed],[aria-expanded]';
    const controls = [];
    for (const node of document.querySelectorAll(selector)) {
      if (!rendered(node)) continue;
      const id = node.id;
      const labelNode = id ? document.querySelector(`label[for="${escapeCss(id)}"]`) : null;
      const labelledBy = node.getAttribute?.('aria-labelledby');
      const ariaLabelled = labelledBy
        ? [...labelledBy.split(/\s+/)].map((item) => document.getElementById(item)).filter(Boolean).map(textOf).join(' ')
        : '';
      const nearestLabel = node.closest?.('label');
      const label = normalize(
        node.getAttribute?.('aria-label')
        || ariaLabelled
        || textOf(labelNode)
        || textOf(nearestLabel)
        || node.getAttribute?.('placeholder')
        || node.getAttribute?.('name')
        || textOf(node),
      );
      let value = '';
      if (node.tagName?.toLowerCase() === 'select') {
        value = [...node.selectedOptions || []].map((option) => textOf(option) || option.value).join(', ');
      } else if ('value' in node) value = String(node.value ?? '');
      else value = textOf(node);
      controls.push({
        tagName: node.tagName.toLowerCase(),
        role: node.getAttribute?.('role') || null,
        type: node.getAttribute?.('type') || null,
        label,
        value: normalize(value),
        placeholder: normalize(node.getAttribute?.('placeholder') || ''),
        checked: 'checked' in node ? Boolean(node.checked) : null,
        selected: node.getAttribute?.('aria-selected') === 'true' || null,
        pressed: node.getAttribute?.('aria-pressed') || null,
        expanded: node.getAttribute?.('aria-expanded') || null,
        disabled: Boolean(node.disabled || node.getAttribute?.('aria-disabled') === 'true'),
      });
      if (controls.length >= limit) break;
    }
    return controls;
  }

  function pageTextSample(maxChars = 16000) {
    const main = document.querySelector('main,[role="main"],#content,.content,.main-content') || document.body;
    return textOf(main).slice(0, maxChars);
  }

  function routeState() {
    return {
      route: `${location.pathname || '/'}${location.search || ''}${location.hash || ''}`,
      pathname: location.pathname || '/',
      search: location.search || '',
      hash: location.hash || '',
      queryParameters: Object.fromEntries(new URLSearchParams(location.search || '')),
    };
  }

  function breadcrumbs(limit = 30) {
    const selectors = '[aria-label*="breadcrumb" i] a,[aria-label*="breadcrumb" i] li,.breadcrumb a,.breadcrumbs a,[data-testid*="breadcrumb" i] a';
    const items = [];
    const seen = new Set();
    for (const node of document.querySelectorAll(selectors)) {
      if (!rendered(node)) continue;
      const text = textOf(node);
      const href = absoluteHref(node);
      const key = `${text}|${href}`;
      if ((!text && !href) || seen.has(key)) continue;
      seen.add(key);
      items.push({ text, href });
      if (items.length >= limit) break;
    }
    return items;
  }

  function navigationLinks(limit = 100) {
    const links = [];
    const seen = new Set();
    for (const node of document.querySelectorAll('nav a[href],[role="navigation"] a[href],aside a[href],[role="tablist"] a[href]')) {
      if (!rendered(node)) continue;
      const text = textOf(node);
      const href = absoluteHref(node);
      const key = `${text}|${href}`;
      if ((!text && !href) || seen.has(key)) continue;
      seen.add(key);
      links.push({
        text,
        href,
        current: node.getAttribute?.('aria-current') || null,
        selected: node.getAttribute?.('aria-selected') === 'true' || null,
      });
      if (links.length >= limit) break;
    }
    return links;
  }

  function activeState(controls) {
    return {
      selectedTabs: controls.filter((item) => item.role === 'tab' && item.selected).map((item) => item.label || item.value),
      activeFilters: controls.filter((item) => {
        if (item.role === 'tab') return false;
        if (item.checked === true || item.selected === true || item.pressed === 'true') return true;
        return Boolean(item.value && !['button', 'submit', 'reset'].includes(item.type || ''));
      }),
    };
  }

  const tableRowSelector = [
    'tbody tr', '[role="row"]', 'mat-row', 'cdk-row', '.mat-mdc-row', '.mat-row',
    '.ag-row', '.MuiDataGrid-row', '.ant-table-row', '.el-table__row',
    '[data-row-index]', '[aria-rowindex]', '[data-testid*="row" i]', '[class*="table-row" i]',
  ].join(',');
  const cellSelector = [
    'td', 'th', '[role="gridcell"]', '[role="cell"]', '[role="rowheader"]', '[role="columnheader"]',
    'mat-cell', 'mat-header-cell', 'cdk-cell', 'cdk-header-cell', '.mat-mdc-cell', '.mat-cell',
    '.ag-cell', '.MuiDataGrid-cell', '.ant-table-cell', '.el-table__cell',
  ].join(',');
  const listItemSelector = '[role="listitem"],[role="option"],[role="article"],li,[data-testid*="item" i],[class*="list-item" i],[class*="card" i]';

  function findScroller(rootNode) {
    const documentScroller = document.scrollingElement || document.documentElement;
    for (let node = rootNode; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.scrollHeight > node.clientHeight + 40 && /(auto|scroll|overlay)/.test(style.overflowY || '')) return { scroller: node, isDocument: false };
    }
    return { scroller: documentScroller, isDocument: true };
  }

  function regionKind(rootNode) {
    const role = rootNode.getAttribute?.('role');
    const tag = rootNode.tagName?.toLowerCase();
    const descriptor = `${role || ''} ${tag || ''} ${rootNode.className || ''} ${rootNode.id || ''}`.toLowerCase();
    if (tag === 'table' || /table|grid|treegrid|datagrid/.test(descriptor)) return 'table';
    if (/listbox|list|feed/.test(descriptor)) return 'list';
    return 'collection';
  }

  function headersForSurface(surface) {
    if (surface.kind !== 'table') return [];
    const selectors = 'thead th,[role="columnheader"],mat-header-cell,cdk-header-cell,.mat-mdc-header-cell,.mat-header-cell,.ag-header-cell,.MuiDataGrid-columnHeader,.ant-table-thead th,.el-table__header th';
    const headers = [...surface.root.querySelectorAll(selectors)].filter(rendered).map(textOf).filter(Boolean);
    if (headers.length) return headers;
    const firstRow = surface.root.querySelector('thead tr,[role="row"],mat-header-row,cdk-header-row');
    return firstRow ? [...firstRow.children].filter(rendered).map(textOf).filter(Boolean) : [];
  }

  function surfaceRows(surface) {
    if (surface.kind === 'table') {
      const rows = [...surface.root.querySelectorAll(tableRowSelector)].filter(rendered);
      return rows.filter((row) => !row.matches('thead tr,mat-header-row,cdk-header-row,.ag-header-row,.MuiDataGrid-columnHeaders *') && row.getAttribute?.('role') !== 'columnheader');
    }
    const candidates = [...surface.root.querySelectorAll(listItemSelector)].filter(rendered);
    return candidates.filter((node) => !node.closest('nav,[role="navigation"],aside'));
  }

  function discoverSurfaces(maxSurfaces = 8) {
    const selectors = [
      'table,[role="table"],[role="grid"],[role="treegrid"],mat-table,cdk-table,.mat-mdc-table,.mat-table',
      '.ag-root,.ag-body-viewport,.MuiDataGrid-root,.ant-table,.el-table,.v-data-table,.ReactVirtualized__Grid',
      '[data-testid*="table" i],[data-testid*="grid" i],cdk-virtual-scroll-viewport,[class*="virtual-scroll" i]',
      '[role="list"],[role="listbox"],[role="feed"],[data-testid*="list" i],[class*="list-container" i]',
    ].join(',');
    const candidates = [];
    const seen = new Set();
    for (const rootNode of document.querySelectorAll(selectors)) {
      if (!(rootNode instanceof HTMLElement) || seen.has(rootNode) || !rendered(rootNode)) continue;
      if (rootNode.closest('nav,[role="navigation"]') && !rootNode.matches('table,[role="table"],[role="grid"],[role="treegrid"]')) continue;
      const kind = regionKind(rootNode);
      const { scroller, isDocument } = findScroller(rootNode);
      const surface = { root: rootNode, scroller, isDocument, kind };
      const rows = surfaceRows(surface);
      if (rows.length === 0 && kind !== 'table') continue;
      const headers = headersForSurface(surface);
      const viewport = isDocument ? innerHeight : scroller.clientHeight;
      const scrollHeight = isDocument ? Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) : scroller.scrollHeight;
      const range = Math.max(0, scrollHeight - viewport);
      const descriptor = `${rootNode.className || ''} ${rootNode.id || ''} ${rootNode.getAttribute?.('role') || ''}`;
      const score = rows.length * 500 + headers.length * 900 + Math.min(range, 200000) + (/table|grid|list|virtual|data|result/i.test(descriptor) ? 2500 : 0);
      seen.add(rootNode);
      candidates.push({ ...surface, score, headers, rowCount: rows.length, range });
    }
    if (!candidates.length) {
      const looseRows = [...document.querySelectorAll(tableRowSelector)].filter(rendered);
      if (looseRows.length) {
        const scroller = document.scrollingElement || document.documentElement;
        const surface = { root: document.body, scroller, isDocument: true, kind: 'table' };
        candidates.push({
          ...surface,
          score: looseRows.length * 500,
          headers: headersForSurface(surface),
          rowCount: looseRows.length,
          range: Math.max(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - innerHeight),
        });
      }
    }
    return candidates.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(12, Number(maxSurfaces || 8))));
  }

  function accessors(surface) {
    return {
      getTop: () => surface.isDocument ? window.scrollY : surface.scroller.scrollTop,
      setTop: (value) => {
        if (surface.isDocument) window.scrollTo({ top: value, behavior: 'auto' });
        else surface.scroller.scrollTop = value;
      },
      viewport: () => surface.isDocument ? innerHeight : surface.scroller.clientHeight,
      scrollHeight: () => surface.isDocument ? Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) : surface.scroller.scrollHeight,
    };
  }

  function extractRow(rowNode, surface, surfaceIndex) {
    let cellNodes = surface.kind === 'table' ? [...rowNode.querySelectorAll(cellSelector)].filter(rendered) : [];
    if (!cellNodes.length && surface.kind === 'table') cellNodes = [...rowNode.children].filter(rendered);
    const cells = cellNodes.length ? cellNodes.map(textOf) : [textOf(rowNode)];
    const links = [...rowNode.querySelectorAll('a[href]')].filter(rendered).map((link) => ({ text: textOf(link), href: absoluteHref(link) })).filter((link) => link.text || link.href);
    const rawIndex = rowNode.getAttribute?.('aria-rowindex') ?? rowNode.getAttribute?.('data-row-index') ?? rowNode.getAttribute?.('data-index');
    return core.buildStructuredRow({
      key: sourceIdOf(rowNode),
      sourceId: sourceIdOf(rowNode),
      rowIndex: rawIndex,
      headers: surface.headers,
      cells,
      text: textOf(rowNode),
      links,
      surfaceIndex,
      surfaceType: surface.kind,
    });
  }

  function detailPairs(limit = 160) {
    const pairs = [];
    const seen = new Set();
    const add = (key, value) => {
      const normalizedKey = normalize(key);
      const normalizedValue = normalize(value);
      if (!normalizedKey || !normalizedValue || normalizedKey === normalizedValue) return;
      const id = `${normalizedKey.toLowerCase()}|${normalizedValue}`;
      if (seen.has(id)) return;
      seen.add(id);
      pairs.push({ key: normalizedKey, value: normalizedValue, sourceUrl: location.href });
    };
    for (const dl of document.querySelectorAll('dl')) {
      const children = [...dl.children];
      for (let index = 0; index < children.length; index += 1) {
        if (children[index].tagName?.toLowerCase() !== 'dt') continue;
        const next = children[index + 1];
        if (next?.tagName?.toLowerCase() === 'dd') add(textOf(children[index]), textOf(next));
      }
    }
    for (const row of document.querySelectorAll('[class*="detail" i] [class*="row" i],[class*="property" i],[class*="field" i],[data-testid*="detail" i],[data-testid*="property" i]')) {
      if (!rendered(row)) continue;
      const children = [...row.children].filter(rendered).map(textOf).filter(Boolean);
      if (children.length >= 2) add(children[0], children.slice(1).join(' | '));
      if (pairs.length >= limit) break;
    }
    for (const row of document.querySelectorAll('table tr')) {
      if (!rendered(row)) continue;
      const cells = [...row.querySelectorAll(':scope > th,:scope > td')].filter(rendered).map(textOf).filter(Boolean);
      if (cells.length === 2 && cells[0].length <= 120) add(cells[0], cells[1]);
      if (pairs.length >= limit) break;
    }
    return pairs.slice(0, limit);
  }

  function paginationState() {
    const rootNode = document.querySelector('[aria-label*="pagination" i],nav[class*="pagination" i],[class*="pagination" i]');
    if (!rootNode || !rendered(rootNode)) return null;
    return {
      text: textOf(rootNode),
      current: textOf(rootNode.querySelector('[aria-current="page"],[aria-selected="true"],.active,.selected')) || null,
      disabledControls: [...rootNode.querySelectorAll('[disabled],[aria-disabled="true"]')].filter(rendered).map(textOf).filter(Boolean),
    };
  }

  async function inspect(options = {}) {
    const controls = visibleControls(options.maxControls || 100);
    const sample = pageTextSample(options.maxTextChars || 16000);
    const surfaces = discoverSurfaces(options.maxSurfaces || options.maxRegions || 8);
    const appProfile = core.detectAppProfile({ url: location.href, title: document.title, text: sample });
    const route = routeState();
    const details = detailPairs(options.maxDetailPairs || 160);
    return {
      ok: true,
      readOnly: true,
      appProfile,
      appType: appProfile.product,
      title: document.title,
      url: location.href,
      origin: location.origin,
      ...route,
      breadcrumbs: breadcrumbs(30),
      controls,
      activeState: activeState(controls),
      navigation: navigationLinks(options.maxNavigationLinks || 100),
      pagination: paginationState(),
      dataSurfaces: surfaces.map((surface, index) => ({
        index,
        type: surface.kind,
        headers: surface.headers,
        visibleRowCount: surfaceRows(surface).length,
        scrollable: surface.range > 40,
        scrollRange: Math.round(surface.range),
        ariaRowCount: Number(surface.root.getAttribute?.('aria-rowcount')) || null,
        role: surface.root.getAttribute?.('role') || null,
        tagName: surface.root.tagName?.toLowerCase?.() || null,
      })),
      details,
      artifacts: core.extractArtifactReferences(`${sample}\n${JSON.stringify(details)}`),
      confirmedFacts: core.buildConfirmedFacts({ details, url: location.href }),
      inferences: [],
      diagnostics: {
        screenshotUsed: false,
        clickUsed: false,
        keyboardUsed: false,
        uiSearchBoxUsed: false,
        urlSearchParameterMutated: false,
        structuredDom: true,
      },
    };
  }

  function embeddedJsonSources(options = {}) {
    const maxSources = Math.max(1, Math.min(20, Number(options.maxEmbeddedSources || 8)));
    const maxChars = Math.max(1000, Math.min(5000000, Number(options.maxDataBytes || 2000000)));
    const sources = [];
    const seen = new Set();
    const add = (label, text) => {
      const raw = String(text || '').trim();
      if (!raw || raw.length > maxChars || !/^[\[{]/.test(raw)) return;
      const key = `${label}|${raw.length}|${raw.slice(0, 80)}`;
      if (seen.has(key)) return;
      try {
        const data = JSON.parse(raw);
        seen.add(key);
        sources.push({ sourceType: 'embedded_json', sourceUrl: location.href, label, data, byteLength: raw.length });
      } catch {}
    };
    for (const script of document.querySelectorAll('script[type="application/json"],script#__NEXT_DATA__,script[data-state],script[id*="state" i]')) {
      add(script.id || script.getAttribute('data-testid') || 'script_json', script.textContent);
      if (sources.length >= maxSources) break;
    }
    const globals = ['__NEXT_DATA__', '__NUXT__', '__INITIAL_STATE__', '__APOLLO_STATE__', '__PRELOADED_STATE__'];
    for (const name of globals) {
      if (sources.length >= maxSources) break;
      try {
        const value = globalThis[name];
        if (!value || typeof value !== 'object') continue;
        const raw = JSON.stringify(value);
        if (raw.length <= maxChars) {
          sources.push({ sourceType: 'page_state', sourceUrl: location.href, label: name, data: value, byteLength: raw.length });
        }
      } catch {}
    }
    return sources.slice(0, maxSources);
  }

  function performanceDataCandidates(queryText, options = {}) {
    let entries = [];
    try {
      entries = performance.getEntriesByType('resource').map((entry) => ({
        url: entry.name,
        initiatorType: entry.initiatorType,
      }));
    } catch {}
    return core.rankDataEndpoints(entries, location.href, queryText, options);
  }

  async function fetchJsonSource(candidate, options = {}) {
    const timeoutMs = Math.max(500, Math.min(20000, Number(options.dataTimeoutMs || 5000)));
    const maxBytes = Math.max(10000, Math.min(10000000, Number(options.maxDataBytes || 3000000)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(candidate.url, {
        method: 'GET',
        credentials: 'include',
        redirect: 'follow',
        cache: 'no-store',
        headers: { Accept: 'application/json, text/json, */*;q=0.5' },
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, url: candidate.url, status: response.status, code: 'http_error' };
      const finalUrl = new URL(response.url || candidate.url, location.href);
      if (finalUrl.origin !== location.origin) return { ok: false, url: candidate.url, code: 'cross_origin_redirect' };
      const length = Number(response.headers.get('content-length') || 0);
      if (length > maxBytes) return { ok: false, url: candidate.url, code: 'response_too_large', contentLength: length };
      const text = await response.text();
      if (text.length > maxBytes) return { ok: false, url: candidate.url, code: 'response_too_large', contentLength: text.length };
      if (!/^[\s]*[\[{]/.test(text)) return { ok: false, url: candidate.url, code: 'not_json' };
      try {
        return {
          ok: true,
          url: finalUrl.href,
          sourceType: 'same_origin_get_json',
          contentType: response.headers.get('content-type') || null,
          byteLength: text.length,
          data: JSON.parse(text),
        };
      } catch (error) {
        return { ok: false, url: candidate.url, code: 'json_parse_failed', error: String(error) };
      }
    } catch (error) {
      return { ok: false, url: candidate.url, code: error?.name === 'AbortError' ? 'timeout' : 'fetch_failed', error: String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  function factsFromDataMatches(matches = [], sourceUrl) {
    const facts = [];
    const seen = new Set();
    const add = (field, value, match, itemPath = null) => {
      const normalized = normalize(value);
      if (!normalized) return;
      const key = `${field}|${normalized}|${sourceUrl || match?.sourceUrl || ''}|${match?.entityPath || ''}|${itemPath || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      facts.push({
        field,
        value: normalized,
        sourceType: 'structured_data',
        sourceUrl: match?.sourceUrl || sourceUrl || location.href,
        entityPath: match?.entityPath || null,
        matchedPath: match?.matchedPath || itemPath || null,
      });
    };
    for (const match of matches) {
      add('Resource Name', match.entityName, match);
      add('Resource Kind', match.entityKind, match);
      add('Namespace', match.namespace, match);
      add('Matched Field', match.matchedPath, match);
      add('Matched Value', match.matchedValue, match);
      for (const item of match.context || []) {
        if (!item.preferred) continue;
        const field = String(item.path || '').replace(/^\$\.?/, '');
        add(field, item.value, match, item.path);
      }
    }
    return facts;
  }

  async function queryStructuredData(queryText, options = {}, fetchNetwork = true) {
    const mode = String(options.dataMode || 'auto').toLowerCase();
    if (mode === 'never' || mode === 'off') {
      return { attempted: false, mode, networkFetchAttempted: false, matches: [], entities: [], sources: [], diagnostics: [] };
    }
    const maxDataSources = Math.max(1, Math.min(12, Number(options.maxDataSources || 6)));
    const maxDataMatches = Math.max(1, Math.min(200, Number(options.maxDataMatches || 50)));
    const sources = embeddedJsonSources(options);
    const diagnostics = [];

    const searchSources = (sourceList) => {
      const matches = [];
      for (const source of sourceList) {
        const result = core.deepQueryJson(source.data, queryText, {
          terms: options.terms,
          maxMatches: maxDataMatches,
          maxNodes: options.maxDataNodes || 80000,
          maxDepth: options.maxDataDepth || 24,
          maxFields: options.maxContextFields || 120,
        });
        for (const match of result.matches) {
          matches.push({
            ...match,
            sourceType: source.sourceType,
            sourceUrl: source.url || source.sourceUrl || location.href,
            sourceLabel: source.label || null,
            sourceByteLength: source.byteLength || null,
            visitedNodes: result.visitedNodes,
            sourceTruncated: result.truncated,
          });
        }
      }
      const deduped = [];
      const seen = new Set();
      for (const match of matches.sort((a, b) => b.score - a.score)) {
        const key = `${match.sourceUrl}|${match.entityPath}|${match.matchedPath}|${match.matchedValue}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(match);
        if (deduped.length >= maxDataMatches) break;
      }
      return deduped;
    };

    let matches = searchSources(sources);
    let networkFetchAttempted = false;
    const shouldFetch = fetchNetwork && (mode === 'always' || matches.length === 0);
    if (shouldFetch) {
      networkFetchAttempted = true;
      const endpoints = performanceDataCandidates(queryText, { ...options, maxDataSources });
      for (const endpoint of endpoints.slice(0, maxDataSources)) {
        const fetched = await fetchJsonSource(endpoint, options);
        diagnostics.push({
          url: endpoint.url,
          score: endpoint.score,
          initiatorType: endpoint.initiatorType,
          ok: fetched.ok === true,
          code: fetched.code || null,
          status: fetched.status || null,
          byteLength: fetched.byteLength || null,
        });
        if (fetched.ok) sources.push(fetched);
      }
      matches = searchSources(sources);
    }

    return {
      attempted: true,
      mode,
      networkFetchAttempted,
      matches,
      entities: core.groupResolvedEntities(matches, { maxEntities: options.maxResolvedEntities || 20 }),
      sources: sources.map((source) => ({
        sourceType: source.sourceType,
        sourceUrl: source.url || source.sourceUrl || location.href,
        sourceLabel: source.label || null,
        byteLength: source.byteLength || null,
      })),
      diagnostics,
    };
  }

  async function query(options = {}) {
    const queryText = normalize(options.query);
    if (!queryText) return { ok: false, found: false, code: 'query_required' };
    const maxSteps = Math.max(1, Math.min(2500, Number(options.maxSteps || 300)));
    const maxRows = Math.max(1, Math.min(1000, Number(options.maxRows || 100)));
    const settleMs = Math.max(20, Math.min(1200, Number(options.settleMs || 80)));
    const restoreScroll = options.restoreScroll !== false;
    const stopAfterMatches = Math.max(1, Math.min(maxRows, Number(options.stopAfterMatches || Math.min(maxRows, 20))));
    const controls = visibleControls(100);
    const sample = pageTextSample(16000);
    const appProfile = core.detectAppProfile({ url: location.href, title: document.title, text: sample });
    const surfaces = discoverSurfaces(options.maxSurfaces || options.maxRegions || 8);
    const allRows = new Map();
    const surfaceDiagnostics = [];

    for (let surfaceIndex = 0; surfaceIndex < surfaces.length; surfaceIndex += 1) {
      const surface = surfaces[surfaceIndex];
      const access = accessors(surface);
      const initialTop = access.getTop();
      let lastTop = -1;
      let stableBottom = 0;
      let reachedBottom = false;
      let steps = 0;
      let lastSurfaceCount = 0;
      let stoppedAfterMatches = false;
      if (options.searchFromTop !== false) access.setTop(0);
      try {
        for (; steps < maxSteps; steps += 1) {
          await sleep(settleMs);
          surface.headers = headersForSurface(surface);
          let surfaceCount = 0;
          for (const rowNode of surfaceRows(surface)) {
            const row = extractRow(rowNode, surface, surfaceIndex);
            if (!row.text) continue;
            surfaceCount += 1;
            if (!allRows.has(row.key)) allRows.set(row.key, row);
          }
          const rankedCurrent = core.rankRows([...allRows.values()], queryText, options);
          if (rankedCurrent.length >= stopAfterMatches && options.scanToBottom !== true) {
            stoppedAfterMatches = true;
            break;
          }
          const viewport = Math.max(1, access.viewport());
          const maxTop = Math.max(0, access.scrollHeight() - viewport);
          const currentTop = Math.max(0, Math.min(maxTop, access.getTop()));
          reachedBottom = currentTop >= maxTop - 3;
          if (reachedBottom) {
            stableBottom = surfaceCount === lastSurfaceCount ? stableBottom + 1 : 0;
            lastSurfaceCount = surfaceCount;
            if (stableBottom >= 3) break;
          } else stableBottom = 0;
          const nextTop = Math.min(maxTop, currentTop + Math.max(220, viewport * 0.82));
          if (Math.abs(nextTop - currentTop) < 2 || currentTop === lastTop) {
            if (reachedBottom) break;
            access.setTop(Math.min(maxTop, currentTop + viewport));
          } else access.setTop(nextTop);
          lastTop = currentTop;
        }
      } finally {
        if (restoreScroll) access.setTop(initialTop);
      }
      surfaceDiagnostics.push({
        surfaceIndex,
        type: surface.kind,
        steps,
        reachedBottom,
        bottomStable: stableBottom >= 3,
        stoppedAfterMatches,
        headers: surface.headers,
        uniqueRowsCollected: [...allRows.values()].filter((row) => row.surfaceIndex === surfaceIndex).length,
      });
      if (core.rankRows([...allRows.values()], queryText, options).length >= stopAfterMatches && options.scanToBottom !== true) break;
    }

    const ranked = core.rankRows([...allRows.values()], queryText, options).slice(0, maxRows);
    const matcher = core.createMatcher(queryText, options);
    const details = detailPairs(240);
    const detailMatches = details.filter((item) => matcher(`${item.key} ${item.value}`));
    const textMatches = [];
    if (!ranked.length && !detailMatches.length) {
      for (const node of document.querySelectorAll('main p,main li,main pre,main code,[role="main"] p,[role="main"] li,[role="alert"],[role="status"]')) {
        if (!rendered(node)) continue;
        const text = textOf(node);
        if (text && matcher(text)) textMatches.push(text);
        if (textMatches.length >= 30) break;
      }
    }
    const domConfirmedFacts = core.buildConfirmedFacts({ rows: ranked, details: detailMatches, url: location.href });
    const domFieldMatches = core.matchRequestedFields(domConfirmedFacts, options.fields || []);
    const dataMode = String(options.dataMode || 'auto').toLowerCase();
    const shouldFetchNetworkData = dataMode === 'always'
      || options.deepSearch === true
      || ranked.length === 0
      || domFieldMatches.missingFields.length > 0;
    const structuredData = await queryStructuredData(queryText, options, shouldFetchNetworkData);
    const structuredFacts = factsFromDataMatches(structuredData.matches || [], location.href);
    const confirmedFacts = [];
    const factKeys = new Set();
    for (const fact of [...domConfirmedFacts, ...structuredFacts]) {
      const key = `${String(fact.field || '').toLowerCase()}|${String(fact.value || '')}|${fact.sourceUrl || ''}|${fact.entityPath || ''}`;
      if (factKeys.has(key)) continue;
      factKeys.add(key);
      confirmedFacts.push(fact);
    }
    const fieldMatches = core.matchRequestedFields(confirmedFacts, options.fields || []);
    const detailCandidates = core.selectDetailLinks(ranked, location.href, {
      query: queryText,
      terms: options.terms,
      maxDetailLinks: options.maxDetailLinks || 2,
    });
    const scanComplete = surfaces.length > 0 && surfaceDiagnostics.every((item) => item.reachedBottom && item.bottomStable && !item.stoppedAfterMatches);
    return {
      ok: true,
      found: ranked.length > 0 || detailMatches.length > 0 || textMatches.length > 0 || structuredData.matches.length > 0,
      readOnly: true,
      appProfile,
      appType: appProfile.product,
      title: document.title,
      url: location.href,
      origin: location.origin,
      ...routeState(),
      query: queryText,
      queryTerms: core.tokenizeQuery(queryText, options.terms),
      matches: ranked,
      detailMatches,
      textMatches,
      structuredData,
      resolvedEntities: structuredData.entities,
      resolution: structuredData.entities.length ? {
        status: 'resolved_entities',
        primaryEntity: structuredData.entities[0],
        entityCount: structuredData.entities.length,
        instruction: 'Answer with the concrete entity name and evidence; do not replace it with a vague conclusion.',
      } : {
        status: ranked.length || detailMatches.length || textMatches.length ? 'dom_match_only' : 'not_resolved',
        primaryEntity: null,
        entityCount: 0,
      },
      confirmedFacts,
      fieldMatches,
      detailCandidates,
      artifacts: core.extractArtifactReferences(`${ranked.map((row) => row.text).join('\n')}\n${detailMatches.map((item) => `${item.key} ${item.value}`).join('\n')}\n${(structuredData.matches || []).flatMap((item) => [item.matchedValue, ...(item.context || []).map((field) => field.value)]).join('\n')}`),
      inferences: [],
      assumptions: [],
      scan: {
        complete: scanComplete,
        surfaceCount: surfaces.length,
        uniqueRowsVisited: allRows.size,
        maxSteps,
        surfaceDiagnostics,
      },
      currentState: {
        controls,
        activeState: activeState(controls),
        breadcrumbs: breadcrumbs(30),
        navigation: navigationLinks(100),
        pagination: paginationState(),
      },
      diagnostics: {
        screenshotUsed: false,
        clickUsed: false,
        keyboardUsed: false,
        uiSearchBoxUsed: false,
        urlSearchParameterMutated: false,
        structuredDom: true,
        virtualSurfaceScan: true,
        structuredDataAttempted: structuredData.attempted,
        structuredDataSourceCount: structuredData.sources.length,
        structuredDataMatchCount: structuredData.matches.length,
        sameOriginGetOnly: true,
        currentUserTabChanged: false,
      },
    };
  }

  root.OpenClaudeWebAppReader = Object.freeze({ inspect, query, discoverSurfaces });
})(globalThis);
