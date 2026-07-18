/* Shared Lark reader core used by the production extension and Node tests. */
((root) => {
  const HEADING_RE = /^heading([1-6])$/;

  function normalizeText(value) {
    return String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function hash32(input, seed) {
    let hash = seed >>> 0;
    const value = String(input);
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
      hash ^= hash >>> 13;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function stableFingerprint(block) {
    const input = [
      block?.sourceId || '',
      block?.type || 'paragraph',
      normalizeText(block?.text),
      Number.isFinite(block?.virtualTop) ? Math.round(block.virtualTop) : '',
    ].join('\u241f');
    return `${hash32(input, 2166136261)}${hash32(input, 3339675911)}${hash32(input, 1540483477)}`;
  }

  function normalizeBlockType(type) {
    const value = String(type || 'paragraph').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (/^h[1-6]$/.test(value)) return `heading${value.slice(1)}`;
    if (/^heading[1-6]$/.test(value)) return value;
    if (['pre', 'codeblock'].includes(value)) return 'code';
    if (['td', 'th', 'tablecell', 'cell'].includes(value)) return 'tableCell';
    if (['img', 'picture', 'imageblock', 'image'].includes(value)) return 'image';
    if (['svg', 'canvas', 'flowchart', 'mindmap', 'whiteboard', 'diagram'].includes(value)) return 'diagram';
    if (['blockquote', 'callout'].includes(value)) return 'quote';
    if (['li', 'listitem', 'unordered'].includes(value)) return 'bullet';
    if (['ordered', 'numbered'].includes(value)) return 'ordered';
    if (['hr', 'separator'].includes(value)) return 'divider';
    if (value === 'table') return 'table';
    return 'paragraph';
  }

  function normalizeBlocks(inputBlocks = []) {
    const bySourceId = new Map();
    const byFingerprint = new Map();

    for (const [index, raw] of inputBlocks.entries()) {
      const text = normalizeText(raw?.text);
      const type = normalizeBlockType(raw?.type);
      if (!text && !['image', 'diagram', 'table', 'code', 'divider'].includes(type)) continue;

      const block = {
        ...raw,
        type,
        text,
        isContainer: raw?.isContainer === true,
        leaf: raw?.leaf !== false && raw?.isContainer !== true,
        virtualTop: Number.isFinite(raw?.virtualTop) ? raw.virtualTop : index,
        firstSeen: Number.isFinite(raw?.firstSeen) ? raw.firstSeen : index,
      };
      block.fingerprint = raw?.fingerprint || stableFingerprint(block);

      const existing = block.sourceId ? bySourceId.get(block.sourceId) : byFingerprint.get(block.fingerprint);
      if (existing) continue;
      if (block.sourceId) bySourceId.set(block.sourceId, block);
      else byFingerprint.set(block.fingerprint, block);
    }

    const normalized = [...bySourceId.values(), ...byFingerprint.values()].sort((a, b) => {
      const position = a.virtualTop - b.virtualTop;
      return position !== 0 ? position : a.firstSeen - b.firstSeen;
    });

    return normalized.map((block, ordinal) => ({
      ...block,
      ordinal,
      blockId: block.blockId || `reader:${ordinal}:${block.fingerprint}`,
    }));
  }

  function buildDocumentMap(inputBlocks, metadata = {}) {
    const blocks = normalizeBlocks(inputBlocks);
    const sections = [];
    const stack = [];

    for (const block of blocks) {
      const match = HEADING_RE.exec(block.type);
      if (!match) continue;
      const level = Number(match[1]);

      while (stack.length && stack[stack.length - 1].level >= level) {
        stack.pop().endOrdinal = block.ordinal - 1;
      }

      const section = {
        id: `section:${block.ordinal}:${block.fingerprint}`,
        title: block.text || `Untitled section ${sections.length + 1}`,
        level,
        headingBlockId: block.blockId,
        startOrdinal: block.ordinal,
        endOrdinal: blocks.length - 1,
        parentId: stack.at(-1)?.id || null,
        childIds: [],
        contains: { table: false, code: false, visual: false },
      };
      if (stack.length) stack.at(-1).childIds.push(section.id);
      sections.push(section);
      stack.push(section);
    }

    while (stack.length) stack.pop().endOrdinal = blocks.length - 1;

    for (const section of sections) {
      const slice = blocks.slice(section.startOrdinal, section.endOrdinal + 1);
      section.blockCount = slice.length;
      section.contains.table = slice.some((block) => ['table', 'tableCell'].includes(block.type));
      section.contains.code = slice.some((block) => block.type === 'code');
      section.contains.visual = slice.some((block) => ['image', 'diagram'].includes(block.type));
    }

    return {
      title: metadata.title || inferTitle(blocks),
      url: metadata.url || null,
      blockCount: blocks.length,
      sectionCount: sections.length,
      sections,
      sectionTree: buildSectionTree(sections),
      typeCounts: countBy(blocks, (block) => block.type),
      scan: metadata.scan || null,
      blocks,
    };
  }

  function summarizeDocumentMap(documentMap) {
    return {
      ok: true,
      scope: 'map',
      title: documentMap.title,
      url: documentMap.url,
      blockCount: documentMap.blockCount,
      sectionCount: documentMap.sectionCount,
      typeCounts: documentMap.typeCounts,
      sections: documentMap.sections.map(compactSection),
      sectionTree: documentMap.sectionTree,
      scan: documentMap.scan,
      complete: documentMap.scan?.complete === true,
      sourceIncomplete: documentMap.scan?.complete !== true,
    };
  }

  function readSection(documentMap, selector, options = {}) {
    const sections = documentMap?.sections || [];
    const normalizedSelector = normalizeText(selector).toLowerCase();
    let section = sections.find((item) => item.id === selector);
    if (!section) section = sections.find((item) => item.title.toLowerCase() === normalizedSelector);
    if (!section && normalizedSelector && options.allowPartialTitle !== false) {
      const candidates = sections.filter((item) => item.title.toLowerCase().includes(normalizedSelector));
      if (candidates.length === 1) section = candidates[0];
    }
    if (!section) {
      return {
        ok: false,
        scope: 'section',
        code: normalizedSelector ? 'section_not_found' : 'section_selector_required',
        selector,
        availableSections: sections.slice(0, 100).map(compactSection),
      };
    }

    const maxBlocks = clamp(options.maxBlocks ?? 200, 1, 1000);
    const start = section.startOrdinal;
    const requestedEnd = options.includeChildren === false
      ? nextSameOrHigherHeading(documentMap, section) - 1
      : section.endOrdinal;
    const end = Math.min(requestedEnd, start + maxBlocks - 1);
    return {
      ok: true,
      scope: 'section',
      title: documentMap.title,
      url: documentMap.url,
      blockCount: documentMap.blockCount,
      scan: documentMap.scan,
      sourceIncomplete: documentMap.scan?.complete !== true,
      section: compactSection(section),
      startOrdinal: start,
      endOrdinal: end,
      blocks: documentMap.blocks.slice(start, end + 1),
      truncated: end < requestedEnd,
      nextStartOrdinal: end < requestedEnd ? end + 1 : null,
    };
  }

  function readRange(documentMap, startOrdinal, endOrdinal, options = {}) {
    const total = documentMap?.blocks?.length || 0;
    if (!total) return { ok: true, scope: 'range', startOrdinal: 0, endOrdinal: -1, blocks: [], truncated: false, nextStartOrdinal: null };
    const start = clamp(toInteger(startOrdinal, 0), 0, total - 1);
    const requestedEnd = clamp(toInteger(endOrdinal, start), start, total - 1);
    const maxBlocks = clamp(options.maxBlocks ?? 200, 1, 1000);
    const end = Math.min(requestedEnd, start + maxBlocks - 1);
    return {
      ok: true,
      scope: 'range',
      title: documentMap.title,
      url: documentMap.url,
      blockCount: documentMap.blockCount,
      scan: documentMap.scan,
      sourceIncomplete: documentMap.scan?.complete !== true,
      startOrdinal: start,
      endOrdinal: end,
      requestedEndOrdinal: requestedEnd,
      blocks: documentMap.blocks.slice(start, end + 1),
      truncated: end < requestedEnd,
      nextStartOrdinal: end < requestedEnd ? end + 1 : null,
    };
  }

  function searchDocument(documentMap, query, options = {}) {
    const needle = normalizeText(query);
    if (!needle) return { ok: false, scope: 'search', code: 'query_required', matches: [] };

    const caseSensitive = options.caseSensitive === true;
    const target = caseSensitive ? needle : needle.toLowerCase();
    const contextBefore = clamp(options.contextBefore ?? 1, 0, 20);
    const contextAfter = clamp(options.contextAfter ?? 1, 0, 20);
    const limit = clamp(options.limit ?? 20, 1, 200);
    const cursor = clamp(toInteger(options.cursor, 0), 0, Number.MAX_SAFE_INTEGER);
    const maxTextCharsPerMatch = clamp(options.maxTextCharsPerMatch ?? 800, 80, 10000);
    const maxTotalChars = clamp(options.maxTotalChars ?? 20000, 1000, 200000);
    const leafOnly = options.leafOnly !== false;
    const includeContainers = options.includeContainers === true;
    const allowedTypes = Array.isArray(options.blockTypes) && options.blockTypes.length
      ? new Set(options.blockTypes.map(normalizeBlockType))
      : null;
    const withinSection = resolveSection(documentMap.sections, options.withinSection || options.sectionId || options.sectionTitle);

    const diagnostics = {
      scannedBlocks: documentMap.blocks.length,
      containerMatchesDropped: 0,
      duplicateMatchesDropped: 0,
      typeFilteredMatchesDropped: 0,
      sectionFilteredMatchesDropped: 0,
      charBudgetReached: false,
      sourceIncomplete: documentMap.scan?.complete !== true,
    };

    const hits = [];
    for (const block of documentMap.blocks) {
      const haystack = caseSensitive ? block.text : block.text.toLowerCase();
      if (!haystack.includes(target)) continue;
      if (withinSection && (block.ordinal < withinSection.startOrdinal || block.ordinal > withinSection.endOrdinal)) {
        diagnostics.sectionFilteredMatchesDropped += 1;
        continue;
      }
      if (allowedTypes && !allowedTypes.has(block.type)) {
        diagnostics.typeFilteredMatchesDropped += 1;
        continue;
      }
      if ((leafOnly || !includeContainers) && block.isContainer) {
        diagnostics.containerMatchesDropped += 1;
        continue;
      }

      const section = findContainingSection(documentMap.sections, block.ordinal);
      const semanticKey = `${section?.id || 'root'}\u241f${block.type}\u241f${normalizeText(block.text).toLowerCase()}`;
      const previous = hits.at(-1);
      if (previous && previous.semanticKey === semanticKey && Math.abs(previous.block.ordinal - block.ordinal) <= 2) {
        diagnostics.duplicateMatchesDropped += 1;
        previous.duplicateOrdinals.push(block.ordinal);
        continue;
      }

      hits.push({ block, section, semanticKey, duplicateOrdinals: [] });
    }

    const matches = [];
    let consumedChars = 0;
    let index = cursor;
    for (; index < hits.length && matches.length < limit; index += 1) {
      const hit = hits[index];
      const contextBlocks = collectContext(documentMap.blocks, hit.block.ordinal, contextBefore, contextAfter, { leafOnly });
      const text = truncateText(hit.block.text, maxTextCharsPerMatch);
      const context = contextBlocks.map((block) => ({
        blockId: block.blockId,
        ordinal: block.ordinal,
        type: block.type,
        text: truncateText(block.text, maxTextCharsPerMatch),
      }));
      const estimatedChars = text.length + context.reduce((sum, item) => sum + item.text.length, 0);
      if (matches.length > 0 && consumedChars + estimatedChars > maxTotalChars) {
        diagnostics.charBudgetReached = true;
        break;
      }
      consumedChars += estimatedChars;

      const ranges = [];
      const haystack = caseSensitive ? hit.block.text : hit.block.text.toLowerCase();
      let rangeIndex = haystack.indexOf(target);
      while (rangeIndex >= 0 && ranges.length < 20) {
        ranges.push([rangeIndex, rangeIndex + needle.length]);
        rangeIndex = haystack.indexOf(target, rangeIndex + Math.max(1, needle.length));
      }

      matches.push({
        blockId: hit.block.blockId,
        ordinal: hit.block.ordinal,
        type: hit.block.type,
        text,
        textTruncated: text.length !== hit.block.text.length,
        ranges,
        section: hit.section ? compactSection(hit.section) : null,
        context,
        duplicateOrdinals: hit.duplicateOrdinals,
        hasRelatedVisual: hasNearbyType(documentMap.blocks, hit.block.ordinal, ['image', 'diagram'], 4),
      });
    }

    const nextCursor = index < hits.length ? index : null;
    return {
      ok: true,
      scope: 'search',
      title: documentMap.title,
      url: documentMap.url,
      blockCount: documentMap.blockCount,
      scan: documentMap.scan,
      sourceIncomplete: documentMap.scan?.complete !== true,
      query: needle,
      withinSection: withinSection ? compactSection(withinSection) : null,
      totalMatchingBlocks: hits.length,
      totalMatchesReturned: matches.length,
      cursor,
      nextCursor,
      limitReached: nextCursor !== null,
      matches,
      diagnostics,
    };
  }

  function executeRead(documentMap, options = {}) {
    const scope = options.scope || 'map';
    if (scope === 'map') return summarizeDocumentMap(documentMap);
    if (scope === 'section') {
      return readSection(documentMap, options.sectionId || options.sectionTitle || '', {
        maxBlocks: options.maxReturnBlocks,
        includeChildren: options.includeChildren,
      });
    }
    if (scope === 'range') {
      const defaultEnd = toInteger(options.startOrdinal, 0) + (options.maxReturnBlocks ?? 200) - 1;
      return readRange(documentMap, options.startOrdinal, options.endOrdinal ?? defaultEnd, { maxBlocks: options.maxReturnBlocks });
    }
    if (scope === 'search') return searchDocument(documentMap, options.query, options);
    return { ok: false, code: 'unsupported_scope', scope };
  }


  function classifyDocumentType(signals = {}) {
    const gridCellCount = Number(signals.gridCellCount || 0);
    const tableCellCount = Number(signals.tableCellCount || 0);
    const tableCount = Number(signals.tableCount || 0);
    const headingCount = Number(signals.headingCount || 0);
    const canvasCount = Number(signals.canvasCount || 0);
    const editableCount = Number(signals.editableCount || 0);
    const richDocScore = Number(signals.richDocScore || 0);
    const sheetScore = Number(signals.sheetScore || 0);
    const canvasScore = Number(signals.canvasScore || 0);

    if (sheetScore > 0 || gridCellCount >= 8) return 'sheet';
    if (canvasScore > 0 || (canvasCount > 0 && headingCount === 0 && tableCellCount === 0)) return 'canvas';
    if (tableCount > 0 && tableCellCount >= 4 && headingCount <= 2 && editableCount === 0) return 'table';
    if (richDocScore > 0 || editableCount > 0 || headingCount > 0) return 'rich_doc';
    return 'generic_page';
  }

  function createTextMatcher(query, options = {}) {
    const rawQuery = String(query ?? '');
    const normalizedQuery = normalizeText(rawQuery);
    const caseSensitive = options.caseSensitive === true;
    const matchMode = options.matchMode || 'contains';
    if (!normalizedQuery) return () => false;

    if (matchMode === 'regex') {
      let expression;
      try { expression = new RegExp(rawQuery, caseSensitive ? '' : 'i'); } catch { return () => false; }
      return (value) => expression.test(String(value ?? ''));
    }

    const needle = caseSensitive ? normalizedQuery : normalizedQuery.toLowerCase();
    return (value) => {
      const normalizedValue = normalizeText(value);
      const haystack = caseSensitive ? normalizedValue : normalizedValue.toLowerCase();
      return matchMode === 'exact' ? haystack === needle : haystack.includes(needle);
    };
  }

  function rankLocateCandidates(candidates = [], options = {}) {
    const preferExact = options.preferExact !== false;
    const query = normalizeText(options.query);
    const normalizedQuery = options.caseSensitive ? query : query.toLowerCase();
    return [...candidates].sort((left, right) => {
      const leftText = normalizeText(left?.text);
      const rightText = normalizeText(right?.text);
      const leftComparable = options.caseSensitive ? leftText : leftText.toLowerCase();
      const rightComparable = options.caseSensitive ? rightText : rightText.toLowerCase();
      const leftExact = preferExact && leftComparable === normalizedQuery ? 1 : 0;
      const rightExact = preferExact && rightComparable === normalizedQuery ? 1 : 0;
      if (leftExact !== rightExact) return rightExact - leftExact;
      const leftLeaf = left?.leaf === false || left?.isContainer === true ? 0 : 1;
      const rightLeaf = right?.leaf === false || right?.isContainer === true ? 0 : 1;
      if (leftLeaf !== rightLeaf) return rightLeaf - leftLeaf;
      const leftLengthPenalty = Math.abs(leftText.length - query.length);
      const rightLengthPenalty = Math.abs(rightText.length - query.length);
      if (leftLengthPenalty !== rightLengthPenalty) return leftLengthPenalty - rightLengthPenalty;
      const leftArea = Number(left?.area || Number.MAX_SAFE_INTEGER);
      const rightArea = Number(right?.area || Number.MAX_SAFE_INTEGER);
      return leftArea - rightArea;
    });
  }

  function buildAutomationSource(documentMap, options = {}) {
    return {
      requirementId: options.requirementId || null,
      source: {
        documentTitle: documentMap.title,
        documentUrl: documentMap.url,
        blockCount: documentMap.blockCount,
        complete: documentMap.scan?.complete === true,
      },
      sections: documentMap.sections.map((section) => ({
        sourceSectionId: section.id,
        title: section.title,
        level: section.level,
        startOrdinal: section.startOrdinal,
        endOrdinal: section.endOrdinal,
        contains: section.contains,
      })),
    };
  }

  function buildSectionTree(sections) {
    const byId = new Map(sections.map((section) => [section.id, { ...compactSection(section), children: [] }]));
    const roots = [];
    for (const section of sections) {
      const node = byId.get(section.id);
      if (section.parentId && byId.has(section.parentId)) byId.get(section.parentId).children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  function collectContext(blocks, ordinal, before, after, options = {}) {
    const results = [];
    let index = ordinal - 1;
    while (index >= 0 && results.length < before) {
      const block = blocks[index];
      if (!options.leafOnly || !block.isContainer) results.unshift(block);
      index -= 1;
    }
    const current = blocks[ordinal];
    if (current) results.push(current);
    index = ordinal + 1;
    let afterCount = 0;
    while (index < blocks.length && afterCount < after) {
      const block = blocks[index];
      if (!options.leafOnly || !block.isContainer) {
        results.push(block);
        afterCount += 1;
      }
      index += 1;
    }
    return results;
  }

  function resolveSection(sections, selector) {
    const value = normalizeText(selector);
    if (!value) return null;
    const lower = value.toLowerCase();
    return sections.find((section) => section.id === value)
      || sections.find((section) => section.title.toLowerCase() === lower)
      || sections.find((section) => section.title.toLowerCase().includes(lower))
      || null;
  }

  function inferTitle(blocks) {
    return blocks.find((block) => block.type === 'heading1')?.text
      || blocks.find((block) => block.type.startsWith('heading'))?.text
      || 'Untitled Lark document';
  }

  function countBy(items, keyFn) {
    const result = {};
    for (const item of items) {
      const key = keyFn(item);
      result[key] = (result[key] || 0) + 1;
    }
    return result;
  }

  function compactSection(section) {
    return {
      id: section.id,
      title: section.title,
      level: section.level,
      headingBlockId: section.headingBlockId,
      parentId: section.parentId,
      childIds: section.childIds,
      startOrdinal: section.startOrdinal,
      endOrdinal: section.endOrdinal,
      blockCount: section.blockCount,
      contains: section.contains,
    };
  }

  function nextSameOrHigherHeading(documentMap, section) {
    const next = documentMap.sections.find((candidate) => candidate.startOrdinal > section.startOrdinal && candidate.level <= section.level);
    return next?.startOrdinal ?? documentMap.blocks.length;
  }

  function findContainingSection(sections, ordinal) {
    let best = null;
    for (const section of sections) {
      if (ordinal < section.startOrdinal || ordinal > section.endOrdinal) continue;
      if (!best || section.level >= best.level) best = section;
    }
    return best;
  }

  function hasNearbyType(blocks, ordinal, types, radius) {
    const start = Math.max(0, ordinal - radius);
    const end = Math.min(blocks.length - 1, ordinal + radius);
    for (let index = start; index <= end; index += 1) {
      if (types.includes(blocks[index].type)) return true;
    }
    return false;
  }

  function truncateText(text, maxChars) {
    const value = String(text || '');
    return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
  }

  function toInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  }

  function clamp(value, min, max) {
    const parsed = Number(value);
    const normalized = Number.isFinite(parsed) ? parsed : min;
    return Math.max(min, Math.min(max, normalized));
  }

  root.OpenClaudeLarkReaderCore = Object.freeze({
    normalizeText,
    stableFingerprint,
    normalizeBlockType,
    normalizeBlocks,
    buildDocumentMap,
    summarizeDocumentMap,
    readSection,
    readRange,
    searchDocument,
    executeRead,
    buildAutomationSource,
    classifyDocumentType,
    createTextMatcher,
    rankLocateCandidates,
  });
})(globalThis);
