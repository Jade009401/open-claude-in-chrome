/* Read-only Lark virtual-scroll scanner. Mapping/search logic lives in the shared core. */
((rootScope) => {
  const BLOCK_SELECTOR = [
    '[data-block-id]', '[data-node-id]', '[data-record-id]', '[data-testid*="block" i]',
    '[class*="block" i]', 'h1,h2,h3,h4,h5,h6', 'p', 'li', 'blockquote', 'pre', 'table',
    'td', 'th', 'img', 'picture', 'svg', 'canvas', 'hr', '[contenteditable="true"] > div',
  ].join(',');

  const OUTLINE_PANEL_SELECTOR = '[class*="outline" i],[class*="catalog" i],[class*="toc" i],[data-testid*="outline" i]';
  // Genuine outline/TOC/nav panels are narrow side rails. Lark tags its MAIN
  // CONTENT SCROLLER with the state class "catalogue-opened"; a bare substring
  // match excluded that scroller (and every block inside it) from scanning,
  // which produced shell-only maps with zero body text. Only treat a match as
  // an outline panel when the matched element is actually narrow.
  function isOutlinePanelMember(node, extraSelector = '') {
    const selector = extraSelector ? `${OUTLINE_PANEL_SELECTOR},${extraSelector}` : OUTLINE_PANEL_SELECTOR;
    const matched = node.closest?.(selector);
    if (!matched) return false;
    let width = 0;
    try { width = matched.getBoundingClientRect().width; } catch {}
    return width > 0 && width < Math.max(360, window.innerWidth * 0.42);
  }

  async function frameScan(options = {}) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || min));
    const normalize = (value) => String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const textOf = (node) => normalize(node?.innerText || node?.textContent || '');

    function inferType(node) {
      const tag = node.tagName?.toLowerCase() || '';
      if (/^h[1-6]$/.test(tag)) return `heading${tag.slice(1)}`;
      const ariaLevel = Number(node.getAttribute?.('aria-level'));
      if (ariaLevel >= 1 && ariaLevel <= 6) return `heading${ariaLevel}`;
      if (tag === 'td' || tag === 'th') return 'tableCell';
      if (tag === 'img' || tag === 'picture') return 'image';
      if (tag === 'svg' || tag === 'canvas') return 'diagram';
      if (tag === 'table') return 'table';
      const combined = `${tag} ${String(node.className || '').toLowerCase()} ${String(node.getAttribute?.('data-block-type') || node.getAttribute?.('data-type') || '').toLowerCase()}`;
      const headingMatch = combined.match(/(?:heading|header|title)[-_ ]?([1-6])/);
      if (headingMatch) return `heading${headingMatch[1]}`;
      if (node.matches?.('pre, code') || /code-block|syntax-highlighter/.test(combined)) return 'code';
      if (node.matches?.('blockquote') || /quote|callout/.test(combined)) return 'quote';
      if (node.matches?.('li') || /bullet|ordered-list|list-item/.test(combined)) return /ordered|number/.test(combined) ? 'ordered' : 'bullet';
      if (/image-block|media-block|image-wrapper/.test(combined) && node.querySelector?.('img,picture')) return 'image';
      if (/flow|diagram|mindmap|whiteboard|canvas-block/.test(combined) && node.querySelector?.('svg,canvas')) return 'diagram';
      if (node.matches?.('hr') || /divider/.test(combined)) return 'divider';
      return 'paragraph';
    }

    function isVisibleCandidate(node) {
      if (!(node instanceof HTMLElement || node instanceof SVGElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = node instanceof HTMLElement ? getComputedStyle(node) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      return true;
    }

    function candidateNodes(root) {
      return [...root.querySelectorAll(BLOCK_SELECTOR)].filter((node) => {
        if (!isVisibleCandidate(node)) return false;
        const type = inferType(node);
        const text = textOf(node);
        if (!text && !['image', 'diagram', 'divider'].includes(type)) return false;
        if (isOutlinePanelMember(node)) return false;
        return true;
      });
    }

    function classifyContainer(node, root, type, text) {
      if (node === root) return true;
      if (type === 'table') return true;
      if (node.matches?.('[contenteditable="true"], [role="document"], main, article')) return true;
      if (['image', 'diagram', 'code'].includes(type)) return false;
      let childCount = 0;
      for (const child of node.querySelectorAll?.(BLOCK_SELECTOR) || []) {
        if (child !== node && isVisibleCandidate(child)) {
          childCount += 1;
          if (childCount >= 2) return text.length > 80;
        }
      }
      return false;
    }

    function extractBlock(node, root, scrollTop, firstSeen) {
      const rect = node.getBoundingClientRect();
      const type = inferType(node);
      let text = textOf(node);
      if (type === 'code') {
        const code = node.matches?.('pre,code') ? node : node.querySelector?.('pre,code');
        text = String(code?.innerText || code?.textContent || text).replace(/\r\n/g, '\n').trimEnd();
      }
      const isContainer = classifyContainer(node, root, type, text);
      return {
        sourceId: node.getAttribute?.('data-block-id') || node.getAttribute?.('data-node-id') || node.getAttribute?.('data-record-id') || node.id || null,
        type,
        text,
        isContainer,
        leaf: !isContainer,
        virtualTop: scrollTop + rect.top,
        firstSeen,
        visual: ['image', 'diagram'].includes(type) ? { width: Math.round(rect.width), height: Math.round(rect.height) } : null,
      };
    }

    function discoverOutline() {
      const roots = [...document.querySelectorAll([
        '[data-testid*="outline" i]', '[class*="outline" i]', '[class*="catalog" i]',
        '[class*="toc" i]', '[aria-label*="outline" i]', '[aria-label*="目录" i]',
      ].join(','))];
      let best = null;
      for (const root of roots) {
        if (!(root instanceof HTMLElement)) continue;
        const rect = root.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 120 || rect.width > Math.max(520, window.innerWidth * 0.55)) continue;
        const rawItems = [...root.querySelectorAll('a,button,[role="treeitem"],[role="link"],[data-node-id],[data-block-id],li')];
        const entries = [];
        const seen = new Set();
        for (const node of rawItems) {
          if (!(node instanceof HTMLElement) || !isVisibleCandidate(node)) continue;
          const title = textOf(node);
          if (!title || title.length > 180) continue;
          const key = title.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          entries.push({ title, node });
        }
        if (entries.length < 3) continue;
        const score = entries.length * 1000 + rect.height - rect.width + (rect.left < window.innerWidth * 0.45 ? 500 : 0);
        if (!best || score > best.score) best = { root, entries, score };
      }
      return best || { root: null, entries: [], score: 0 };
    }

    let discoveredTargetCount = 0;
    function discoverTargets() {
      const documentScroller = document.scrollingElement || document.documentElement;
      const elements = [documentScroller, ...document.querySelectorAll('*')];
      const candidates = [];
      const seen = new Set();
      for (const element of elements) {
        if (!(element instanceof HTMLElement)) continue;
        if (seen.has(element)) continue;
        seen.add(element);
        const isDocument = element === documentScroller || element === document.documentElement || element === document.body;
        const rect = isDocument
          ? { width: window.innerWidth, height: window.innerHeight, left: 0, top: 0 }
          : element.getBoundingClientRect();
        const clientHeight = isDocument ? window.innerHeight : element.clientHeight;
        const scrollHeight = isDocument ? Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) : element.scrollHeight;
        const range = Math.max(0, scrollHeight - clientHeight);
        if (clientHeight < 180 || rect.width < Math.max(320, window.innerWidth * 0.32)) continue;
        const style = isDocument ? null : getComputedStyle(element);
        const scrollable = isDocument || range > 120 || /(auto|scroll|overlay)/.test(style?.overflowY || '');
        if (!scrollable) continue;
        if (isOutlinePanelMember(element)) continue;

        const root = chooseContentRoot(element, isDocument);
        const quickCount = root.querySelectorAll?.(BLOCK_SELECTOR).length || 0;
        const name = `${String(element.className || '')} ${element.id || ''} ${element.getAttribute?.('role') || ''}`.toLowerCase();
        const likelyBonus = /(docx|editor|document|content|main|scroll)/.test(name) ? 1200 : 0;
        const score = quickCount * 250 + Math.min(range, 200000) + rect.width * rect.height / 100 + likelyBonus;
        candidates.push({ element, root, isDocument, score, quickCount });
      }
      discoveredTargetCount = candidates.length;
      return candidates.sort((a, b) => b.score - a.score).slice(0, clamp(options.maxTargets || 3, 1, 5));
    }

    function chooseContentRoot(scrollElement, isDocument) {
      const base = isDocument ? document.body : scrollElement;
      const candidates = [base, ...base.querySelectorAll('[role="document"], main, article, [contenteditable="true"], [class*="docx" i], [class*="editor" i], [class*="document" i]')];
      let best = base;
      let bestScore = -1;
      for (const node of candidates) {
        if (!(node instanceof HTMLElement)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width < Math.max(280, window.innerWidth * 0.28) || rect.height < 120) continue;
        const count = node.querySelectorAll(BLOCK_SELECTOR).length;
        const name = `${String(node.className || '')} ${node.id || ''} ${node.getAttribute('role') || ''}`.toLowerCase();
        const score = count * 1000 + Math.min(textOf(node).length, 50000) + rect.width * rect.height / 100 + (/(docx|editor|document)/.test(name) ? 2000 : 0);
        if (score > bestScore) { best = node; bestScore = score; }
      }
      return best;
    }

    function makeTargetAccessors(target) {
      const { element, isDocument } = target;
      return {
        getScrollTop: () => isDocument ? window.scrollY : element.scrollTop,
        setScrollTop: (value) => { if (isDocument) window.scrollTo(0, value); else element.scrollTop = value; },
        getClientHeight: () => isDocument ? window.innerHeight : element.clientHeight,
        getScrollHeight: () => isDocument ? Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) : element.scrollHeight,
      };
    }

    function mergeBlock(blocks, latestBySourceId, anonymousKeys, block) {
      if (block.sourceId) {
        const existingIndex = latestBySourceId.get(block.sourceId);
        if (existingIndex === undefined) {
          latestBySourceId.set(block.sourceId, blocks.length);
          blocks.push(block);
        } else if (block.text.length > blocks[existingIndex].text.length) {
          blocks[existingIndex] = block;
        }
      } else {
        const anonymousKey = `${block.type}|${block.text}|${Math.round(block.virtualTop / 4)}|${block.isContainer ? 1 : 0}`;
        if (!anonymousKeys.has(anonymousKey)) {
          anonymousKeys.add(anonymousKey);
          blocks.push(block);
        }
      }
    }

    function headingTitles(blocks) {
      return blocks
        .filter((block) => /^heading[1-6]$/.test(block.type))
        .map((block) => normalize(block.text).toLowerCase())
        .filter(Boolean);
    }

    function findMissingOutlineTitles(outlineEntries, blocks) {
      if (!outlineEntries.length) return [];
      const headings = headingTitles(blocks);
      return outlineEntries
        .map((entry) => entry.title)
        .filter((title) => {
          const normalizedTitle = normalize(title).toLowerCase();
          return normalizedTitle && !headings.some((heading) => heading === normalizedTitle || heading.includes(normalizedTitle) || normalizedTitle.includes(heading));
        });
    }

    async function scanTarget(target, outline, seedBlocks = null) {
      const access = makeTargetAccessors(target);
      const initialScrollTop = access.getScrollTop();
      const maxBlocks = clamp(options.maxBlocks || 5000, 1, 20000);
      const maxSteps = clamp(options.maxSteps || 1200, 1, 4000);
      const settleMs = clamp(options.settleMs || 80, 20, 1200);
      const bottomStableRequired = clamp(options.bottomStableSteps || 6, 3, 20);
      // Self-imposed per-target deadline: a scan that cannot finish returns
      // gracefully WITH telemetry instead of being killed opaquely by the
      // execution guard. Target budget once tuned: <=30s per user requirement.
      const scanDeadlineMs = clamp(options.scanDeadlineMs || 90000, 5000, 300000);
      const scanStartedAt = Date.now();
      const telemetry = { captureMs: 0, sleepMs: 0, captures: 0, boundaryChecks: 0, samples: [] };
      const sampleNow = (phase) => {
        if (telemetry.samples.length >= 240) return;
        telemetry.samples.push({ t: Date.now() - scanStartedAt, phase, step: stepCount, top: Math.round(access.getScrollTop()), blocks: blocks.length, src: latestBySourceId.size });
      };
      const deadlineExceeded = () => Date.now() - scanStartedAt >= scanDeadlineMs;
      const blocks = [];
      const latestBySourceId = new Map();
      const anonymousKeys = new Set();
      // Strategy-a resume: seed with blocks from a recent partial scan of the
      // same content root so a deadline-hit pass is continued, not discarded.
      if (Array.isArray(seedBlocks)) {
        for (const block of seedBlocks) mergeBlock(blocks, latestBySourceId, anonymousKeys, block);
      }
      let previousUniqueCount = 0;
      let previousScrollHeight = access.getScrollHeight();
      let bottomStableSteps = 0;
      let stepCount = 0;
      let reachedBoundary = false;
      let uniqueGrowthEvents = 0;
      let scrollHeightGrowthEvents = 0;

      // Resolve the content root ONCE per target: recomputing it every step
      // re-read the full subtree innerText of every candidate (a forced reflow
      // over ~100k chars per step) and dominated scan time on large documents.
      const rootStartedAt = Date.now();
      target.root = chooseContentRoot(target.element, target.isDocument);
      const chooseRootMs = Date.now() - rootStartedAt;
      const captureCurrent = () => {
        const captureStartedAt = Date.now();
        const scrollTop = access.getScrollTop();
        for (const node of candidateNodes(target.root)) {
          mergeBlock(blocks, latestBySourceId, anonymousKeys, extractBlock(node, target.root, scrollTop, blocks.length));
        }
        telemetry.captureMs += Date.now() - captureStartedAt;
        telemetry.captures += 1;
      };

      try {
        access.setScrollTop(0);
        await sleep(settleMs);
        for (; stepCount < maxSteps && blocks.length < maxBlocks && !deadlineExceeded(); stepCount += 1) {
          captureCurrent();
          sampleNow('step');
          const uniqueCount = blocks.length;
          if (uniqueCount > previousUniqueCount) uniqueGrowthEvents += 1;
          previousUniqueCount = uniqueCount;

          const viewport = Math.max(200, access.getClientHeight());
          const scrollHeight = access.getScrollHeight();
          if (scrollHeight > previousScrollHeight + 2) scrollHeightGrowthEvents += 1;
          previousScrollHeight = scrollHeight;
          const maxScrollTop = Math.max(0, scrollHeight - viewport);
          const current = access.getScrollTop();
          const atBoundary = current >= maxScrollTop - 4;

          if (atBoundary) {
            reachedBoundary = true;
            telemetry.boundaryChecks += 1;
            sampleNow('boundary');
            // Stability = no NEW SOURCE-IDENTIFIED BLOCKS at a stable bottom.
            // Anonymous blocks (decorative svg/canvas without data-block-id)
            // churn keys as the virtual renderer remounts them, and lazy
            // images jitter scrollHeight — neither may reset the counter, or
            // the loop grinds to maxSteps and blows the execution deadline.
            const beforeSignature = `${latestBySourceId.size}|${Math.round(maxScrollTop)}`;
            access.setScrollTop(Math.max(0, maxScrollTop - Math.floor(viewport * 0.22)));
            await sleep(Math.max(settleMs, 100));
            access.setScrollTop(maxScrollTop + 1);
            await sleep(Math.max(settleMs, 140));
            captureCurrent();
            const afterMaxScrollTop = Math.max(0, access.getScrollHeight() - Math.max(200, access.getClientHeight()));
            const afterSignature = `${latestBySourceId.size}|${Math.round(afterMaxScrollTop)}`;
            bottomStableSteps = beforeSignature === afterSignature ? bottomStableSteps + 1 : 0;
            if (bottomStableSteps >= bottomStableRequired) break;
            continue;
          }

          bottomStableSteps = 0;
          const next = Math.min(maxScrollTop, current + Math.max(180, Math.floor(viewport * 0.7)));
          access.setScrollTop(next);
          await sleep(settleMs);
        }

        // The outline is evidence, not a navigation mechanism. Never click it: clicking
        // requires visual interpretation and changes the user's current interaction state.
        // lark_locate performs DOM/virtual-scroll positioning without clicks.
        const missingOutlineTitles = findMissingOutlineTitles(outline.entries, blocks);
        const core = rootScope.OpenClaudeLarkReaderCore;
        const documentType = core?.classifyDocumentType?.({
          gridCellCount: document.querySelectorAll('[role="gridcell"],[aria-colindex]').length,
          tableCellCount: document.querySelectorAll('td,th,[role="cell"]').length,
          tableCount: document.querySelectorAll('table,[role="grid"]').length,
          headingCount: blocks.filter((block) => /^heading[1-6]$/.test(block.type)).length,
          canvasCount: document.querySelectorAll('canvas,svg').length,
          editableCount: document.querySelectorAll('[contenteditable="true"]').length,
          richDocScore: document.querySelectorAll('[class*="docx" i],[class*="document" i],[role="document"]').length,
          sheetScore: document.querySelectorAll('[class*="sheet" i],[class*="spreadsheet" i],[class*="bitable" i],[class*="grid" i]').length,
          canvasScore: document.querySelectorAll('[class*="whiteboard" i],[class*="mindmap" i]').length,
        }) || 'generic_page';
        const outlineIsCompletenessEvidence = documentType === 'rich_doc' && outline.entries.length > 0 && options.requireOutlineCoverage !== false;
        const leafTextBlocks = blocks.filter((block) => block.leaf !== false && !block.isContainer && Boolean(normalize(block.text)) && !/^heading[1-6]$/.test(block.type));
        const leafTextChars = leafTextBlocks.reduce((sum, block) => sum + normalize(block.text).length, 0);
        const headingBlockCount = blocks.filter((block) => /^heading[1-6]$/.test(block.type)).length;
        const requiredLeafBlocks = outline.entries.length
          ? Math.max(3, Math.min(80, Math.ceil(outline.entries.length * 0.45)))
          : 1;
        const requiredLeafChars = outline.entries.length
          ? Math.max(800, Math.min(16000, outline.entries.length * 140))
          : 200;
        const bodyEvidenceComplete = leafTextBlocks.length >= requiredLeafBlocks && leafTextChars >= requiredLeafChars;
        const deadlineHit = deadlineExceeded();
        const hitLimits = blocks.length >= maxBlocks || stepCount >= maxSteps || deadlineHit;
        const complete = reachedBoundary && bottomStableSteps >= bottomStableRequired && !hitLimits
          && (!outlineIsCompletenessEvidence || missingOutlineTitles.length === 0)
          && bodyEvidenceComplete;
        let terminationReason = 'complete';
        if (hitLimits) terminationReason = deadlineHit ? 'scan_deadline_reached' : blocks.length >= maxBlocks ? 'max_blocks_reached' : 'max_steps_reached';
        else if (outlineIsCompletenessEvidence && missingOutlineTitles.length) terminationReason = 'outline_sections_missing';
        else if (!bodyEvidenceComplete) terminationReason = leafTextBlocks.length === 0 ? 'body_content_missing' : 'body_coverage_insufficient';
        else if (!reachedBoundary) terminationReason = 'scroll_boundary_not_reached';
        else if (bottomStableSteps < bottomStableRequired) terminationReason = 'bottom_not_stable';

        return {
          ok: true,
          title: document.title || 'Untitled Lark document',
          url: location.href,
          blockCount: blocks.length,
          blocks,
          scan: {
            reachedBottom: reachedBoundary,
            documentType,
            complete,
            truncated: !complete,
            terminationReason,
            stepCount,
            maxBlocks,
            maxSteps,
            bottomStableSteps,
            bottomStableRequired,
            uniqueGrowthEvents,
            scrollHeightGrowthEvents,
            virtualized: access.getScrollHeight() > access.getClientHeight() * 2,
            telemetry: {
              elapsedMs: Date.now() - scanStartedAt,
              deadlineMs: scanDeadlineMs,
              deadlineHit,
              chooseRootMs,
              captureMs: telemetry.captureMs,
              captures: telemetry.captures,
              boundaryChecks: telemetry.boundaryChecks,
              samples: telemetry.samples,
            },
            body: {
              evidenceComplete: bodyEvidenceComplete,
              leafTextBlockCount: leafTextBlocks.length,
              leafTextCharCount: leafTextChars,
              headingBlockCount,
              requiredLeafBlocks,
              requiredLeafChars,
            },
            target: {
              isDocumentScroller: target.isDocument,
              score: Math.round(target.score),
              quickCount: target.quickCount,
              className: String(target.element.className || '').slice(0, 200),
              elementId: String(target.element.id || '').slice(0, 80),
              rootClassName: String(target.root?.className || '').slice(0, 200),
              rootId: String(target.root?.id || '').slice(0, 80),
              clientHeight: Math.round(access.getClientHeight()),
              scrollHeight: Math.round(access.getScrollHeight()),
              maxScrollTop: Math.max(0, Math.round(access.getScrollHeight() - access.getClientHeight())),
            },
            outline: {
              detected: outline.entries.length > 0,
              entryCount: outline.entries.length,
              missingCount: missingOutlineTitles.length,
              missingTitles: missingOutlineTitles.slice(0, 50),
              assistUsed: false,
              entriesVisited: 0,
              navigationMode: 'diagnostic_only',
              completenessEvidence: outlineIsCompletenessEvidence,
              coverage: outline.entries.length ? Number(((outline.entries.length - missingOutlineTitles.length) / outline.entries.length).toFixed(4)) : null,
            },
          },
        };
      } finally {
        access.setScrollTop(initialScrollTop);
      }
    }

    const outline = discoverOutline();
    const targets = discoverTargets();
    if (!targets.length) return { ok: false, code: 'document_scroll_container_not_found', blockCount: 0 };

    function recentSeedBlocksForRoot(rootElement) {
      try {
        const rootId = String(rootElement?.id || '');
        const rootClass = String(rootElement?.className || '').slice(0, 60);
        const sessions = [...frameSessionStore().values()]
          .filter((session) => Array.isArray(session?.result?.blocks) && session.result.blocks.length)
          .filter((session) => {
            const sessionTarget = session.result.scan?.target || {};
            return String(sessionTarget.rootId || '') === rootId
              && String(sessionTarget.rootClassName || '').slice(0, 60) === rootClass;
          })
          .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
        return sessions[0]?.result.blocks || null;
      } catch { return null; }
    }

    const results = [];
    // Different scroll candidates frequently resolve to the SAME content root
    // (window vs inner scroller); scanning it repeatedly wasted tens of
    // seconds per build (measured). Scan each distinct root once, seeding from
    // the most recent partial session of that root (strategy-a resume).
    const scannedRoots = new Set();
    for (const target of targets) {
      try {
        const resolvedRoot = chooseContentRoot(target.element, target.isDocument);
        if (scannedRoots.has(resolvedRoot)) continue;
        scannedRoots.add(resolvedRoot);
        results.push(await scanTarget(target, outline, recentSeedBlocksForRoot(resolvedRoot)));
      } catch (error) {
        results.push({ ok: false, code: 'scan_target_failed', error: String(error) });
      }
    }
    const candidates = results.filter((result) => result?.ok && Array.isArray(result.blocks));
    if (!candidates.length) return { ok: false, code: 'document_scan_failed', blockCount: 0, diagnostics: results };
    candidates.sort((a, b) => {
      const aScore = (a.scan.complete ? 1_000_000 : 0) + (a.scan.outline?.coverage || 0) * 100_000 + a.blockCount;
      const bScore = (b.scan.complete ? 1_000_000 : 0) + (b.scan.outline?.coverage || 0) * 100_000 + b.blockCount;
      return bScore - aScore;
    });
    // Ancestry probe: walk up from the known document-body marker recording
    // every ancestor's scroll geometry — pinpoints the real inner scroller and
    // exactly which discoverTargets filter rejected it. Diagnostic-only.
    function probeContentScrollerAncestry() {
      // Anchor on a DEEP content node inside #docx so the upward walk crosses
      // every potential scroll container between the blocks and <body>.
      const marker = document.querySelector('#docx [data-block-id]')
        || document.querySelector('#docx li, #docx ul, #docx p, #docx h1')
        || document.getElementById('docx')
        || document.querySelector('[data-block-id]');
      if (!(marker instanceof HTMLElement)) return { probe: 'scroller_ancestry', found: false };
      const chain = [];
      let node = marker;
      for (let depth = 0; node && node !== document.body && depth < 24; depth += 1) {
        let style = null;
        try { style = getComputedStyle(node); } catch {}
        chain.push({
          tag: node.tagName.toLowerCase(),
          id: String(node.id || '').slice(0, 40),
          cls: String(node.className || '').slice(0, 70),
          clientH: node.clientHeight,
          scrollH: node.scrollHeight,
          range: node.scrollHeight - node.clientHeight,
          overflowY: style?.overflowY || null,
          width: Math.round(node.getBoundingClientRect().width),
        });
        node = node.parentElement;
      }
      return { probe: 'scroller_ancestry', found: true, markerTag: marker.tagName.toLowerCase(), markerId: String(marker.id || '').slice(0, 40), chain };
    }

    const best = candidates[0];
    best.scan.targetCount = targets.length;
    best.scan.discoveredTargetCount = discoveredTargetCount;
    best.scan.candidateSummaries = candidates.map((candidate) => ({
      blockCount: candidate.blockCount,
      complete: candidate.scan.complete,
      terminationReason: candidate.scan.terminationReason,
      outlineCoverage: candidate.scan.outline?.coverage ?? null,
      leafTextCharCount: candidate.scan.body?.leafTextCharCount ?? null,
      leafTextBlockCount: candidate.scan.body?.leafTextBlockCount ?? null,
      target: candidate.scan.target,
    }));
    try { best.scan.candidateSummaries.push(probeContentScrollerAncestry()); } catch {}
    // Per-target timing rides the candidateSummaries channel so it reaches the
    // host diagnostics without touching service-worker passthrough code.
    try {
      best.scan.candidateSummaries.push({
        probe: 'scan_telemetry',
        perTarget: candidates.map((candidate) => ({
          rootId: candidate.scan.target?.rootId || null,
          rootClassName: (candidate.scan.target?.rootClassName || '').slice(0, 60),
          blocks: candidate.blockCount,
          ...(candidate.scan.telemetry || {}),
          samples: (candidate.scan.telemetry?.samples || []).filter((_, index, list) => index < 30 || index >= list.length - 10),
        })),
      });
    } catch {}
    return best;
  }


  const FRAME_SESSION_STORE_KEY = '__OPEN_CLAUDE_LARK_FRAME_SESSIONS_V2__';
  const FRAME_SESSION_TTL_MS = 15 * 60 * 1000;

  function frameSessionStore() {
    const existing = rootScope[FRAME_SESSION_STORE_KEY];
    if (existing instanceof Map) return existing;
    const created = new Map();
    try { Object.defineProperty(rootScope, FRAME_SESSION_STORE_KEY, { value: created, configurable: true }); }
    catch { rootScope[FRAME_SESSION_STORE_KEY] = created; }
    return created;
  }

  function cleanupFrameSessions() {
    const store = frameSessionStore();
    const now = Date.now();
    for (const [id, session] of store) {
      if (!session || now - Number(session.createdAt || 0) > FRAME_SESSION_TTL_MS) store.delete(id);
    }
    while (store.size > 4) store.delete(store.keys().next().value);
    return store;
  }

  function newFrameSessionId() {
    try { return crypto.randomUUID(); }
    catch { return `lark-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  }

  function sessionMetadata(sessionId, session) {
    const result = session?.result || {};
    return {
      ok: result.ok === true,
      sessionId,
      snapshotVersion: 2,
      createdAt: session?.createdAt || null,
      expiresAt: session?.createdAt ? session.createdAt + FRAME_SESSION_TTL_MS : null,
      title: result.title || document.title || 'Untitled Lark document',
      url: result.url || location.href,
      blockCount: Number(result.blockCount || result.blocks?.length || 0),
      scan: result.scan || null,
    };
  }

  function frameProbe() {
    const body = document.body;
    const textLength = String(body?.innerText || '').length;
    const documentMarkers = document.querySelectorAll('[role="document"],[class*="docx" i],[class*="document" i],[data-block-id],[data-node-id]').length;
    const scrollables = [...document.querySelectorAll('main,article,[role="document"],[class*="scroll" i],[class*="editor" i]')]
      .filter((element) => {
        try { return element.scrollHeight > element.clientHeight + 100; } catch { return false; }
      }).length;
    const headingCount = document.querySelectorAll('h1,h2,h3,h4,h5,h6,[aria-level]').length;
    const score = documentMarkers * 20 + scrollables * 50 + Math.min(500, Math.floor(textLength / 500)) + headingCount * 3;
    return {
      ok: true,
      score,
      title: document.title,
      url: location.href,
      textLength,
      documentMarkers,
      scrollables,
      headingCount,
      hasExistingSession: frameSessionStore().size > 0,
    };
  }

  async function frameScanSession(options = {}) {
    cleanupFrameSessions();
    const result = await frameScan(options);
    if (!result?.ok || !Array.isArray(result.blocks)) {
      return { ...(result || { ok: false, code: 'frame_scan_no_result' }), blocks: undefined };
    }
    const sessionId = newFrameSessionId();
    const session = { createdAt: Date.now(), result };
    frameSessionStore().set(sessionId, session);
    return sessionMetadata(sessionId, session);
  }

  function frameSessionLatest() {
    cleanupFrameSessions();
    const sessions = [...frameSessionStore().entries()]
      .sort((a, b) => Number(b[1]?.createdAt || 0) - Number(a[1]?.createdAt || 0));
    if (!sessions.length) return { ok: false, code: 'frame_session_missing' };
    return sessionMetadata(sessions[0][0], sessions[0][1]);
  }

  function frameSessionChunk(sessionId, startOrdinal = 0, endOrdinal = null) {
    cleanupFrameSessions();
    const session = frameSessionStore().get(String(sessionId || ''));
    if (!session?.result?.ok || !Array.isArray(session.result.blocks)) {
      return { ok: false, code: 'frame_session_expired', sessionId: sessionId || null, retryable: true };
    }
    const blocks = session.result.blocks;
    const start = Math.max(0, Math.min(blocks.length, Number(startOrdinal || 0)));
    const requestedEnd = endOrdinal == null ? start + 199 : Number(endOrdinal);
    const end = Math.max(start - 1, Math.min(blocks.length - 1, requestedEnd, start + 249));
    return {
      ok: true,
      sessionId,
      startOrdinal: start,
      endOrdinal: end,
      blockCount: blocks.length,
      blocks: end >= start ? blocks.slice(start, end + 1) : [],
      title: session.result.title,
      url: session.result.url,
      scan: session.result.scan,
    };
  }


  async function frameLocate(options = {}) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const core = rootScope.OpenClaudeLarkReaderCore;
    const seekEngine = rootScope.OpenClaudeVirtualScrollSeek;
    const normalize = core?.normalizeText || ((value) => String(value || '').replace(/\u00a0/g, ' ').replace(/[\t ]+/g, ' ').trim());
    const query = normalize(options.query);
    if (!query) return { ok: true, found: false, code: 'query_required', retryable: false };
    if (!seekEngine?.seek) return { ok: true, found: false, code: 'virtual_scroll_seek_runtime_missing', retryable: true };

    const strategy = String(options.strategy || 'auto').toLowerCase();
    const allowedStrategies = new Set(['auto', 'dom', 'table', 'virtual_scroll', 'scroll_only']);
    const resolvedStrategy = allowedStrategies.has(strategy) ? strategy : 'auto';
    const matcher = core?.createTextMatcher?.(query, {
      caseSensitive: options.caseSensitive === true,
      matchMode: options.matchMode || 'contains',
    }) || ((value) => normalize(value).toLowerCase().includes(query.toLowerCase()));
    const settleMs = Math.max(20, Math.min(1200, Number(options.settleMs || 80)));
    const maxSteps = Math.max(1, Math.min(5000, Number(options.maxSteps || 96)));
    const contextBefore = Math.max(0, Math.min(10, Number(options.contextBefore ?? 2)));
    const contextAfter = Math.max(0, Math.min(10, Number(options.contextAfter ?? 3)));
    const maxContextChars = Math.max(200, Math.min(20000, Number(options.maxContextChars || 4000)));
    const restoreOnNotFound = options.restoreOnNotFound !== false;
    const searchFromTop = options.searchFromTop !== false;
    const targetHint = options.targetHint && typeof options.targetHint === 'object' ? options.targetHint : null;

    const signals = {
      gridCellCount: document.querySelectorAll('[role="gridcell"],[aria-colindex]').length,
      tableCellCount: document.querySelectorAll('td,th,[role="cell"]').length,
      tableCount: document.querySelectorAll('table,[role="grid"]').length,
      headingCount: document.querySelectorAll('h1,h2,h3,h4,h5,h6,[aria-level]').length,
      canvasCount: document.querySelectorAll('canvas,svg').length,
      editableCount: document.querySelectorAll('[contenteditable="true"]').length,
      richDocScore: document.querySelectorAll('[class*="docx" i],[class*="document" i],[role="document"]').length,
      sheetScore: document.querySelectorAll('[class*="sheet" i],[class*="spreadsheet" i],[class*="bitable" i],[class*="grid" i]').length,
      canvasScore: document.querySelectorAll('[class*="whiteboard" i],[class*="mindmap" i]').length,
    };
    const detectedDocumentType = core?.classifyDocumentType?.(signals) || 'generic_page';
    const documentType = options.documentType && options.documentType !== 'auto' ? options.documentType : detectedDocumentType;

    const generalSelector = [
      '[data-block-id]', '[data-node-id]', '[data-record-id]', '[data-testid*="block" i]',
      '[data-testid*="cell" i]', '[class*="block" i]', '[class*="paragraph" i]', '[class*="doc-row" i]',
      'h1,h2,h3,h4,h5,h6', 'p', 'li', 'blockquote', 'pre', 'code', 'td', 'th',
      '[role="gridcell"]', '[role="cell"]', '[role="rowheader"]', '[role="columnheader"]',
      '[contenteditable="true"] > div', '[class*="cell" i]', '[class*="row" i]',
    ].join(',');
    const tableSelector = 'td,th,[role="gridcell"],[role="cell"],[role="rowheader"],[role="columnheader"],[data-row-index],[data-col-index]';
    const ordinalBySourceId = new Map();
    const ordinalByNormalizedText = new Map();
    for (const item of [...(targetHint?.ordinalWindow || []), ...(targetHint?.anchors || [])]) {
      const ordinal = Number(item?.ordinal);
      if (!Number.isFinite(ordinal)) continue;
      if (item?.sourceId) ordinalBySourceId.set(String(item.sourceId), ordinal);
      const itemText = normalize(item?.text);
      if (itemText && !ordinalByNormalizedText.has(itemText)) ordinalByNormalizedText.set(itemText, ordinal);
    }

    function textOf(node) { return normalize(node?.innerText || node?.textContent || ''); }
    function sourceIdOf(node) {
      return node?.getAttribute?.('data-block-id') || node?.getAttribute?.('data-node-id') || node?.getAttribute?.('data-record-id') || node?.id || null;
    }
    function rendered(node) {
      if (!(node instanceof HTMLElement || node instanceof SVGElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      const style = node instanceof HTMLElement ? getComputedStyle(node) : null;
      return !(style && (style.display === 'none' || style.visibility === 'hidden'));
    }
    function excluded(node) {
      return isOutlinePanelMember(node, '[role="navigation"]');
    }
    function leafMatch(node, selector) {
      if (!rendered(node) || excluded(node)) return false;
      const text = textOf(node);
      if (!text || !matcher(text)) return false;
      const descendants = [...node.querySelectorAll?.(selector) || []];
      return !descendants.some((child) => child !== node && rendered(child) && matcher(textOf(child)));
    }
    function selectorForSearch() {
      return resolvedStrategy === 'table' || documentType === 'sheet' || documentType === 'table'
        ? `${tableSelector},${generalSelector}`
        : generalSelector;
    }
    function rankCandidates(nodes) {
      const candidates = nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { node, text: textOf(node), leaf: true, area: Math.max(1, rect.width * rect.height), virtualTop: rect.top };
      });
      return core?.rankLocateCandidates?.(candidates, { query, caseSensitive: options.caseSensitive === true }) || candidates;
    }

    function discoverTargets() {
      const documentScroller = document.scrollingElement || document.documentElement;
      const elements = [documentScroller, ...document.querySelectorAll('*')];
      const candidates = [];
      const seen = new Set();
      for (const element of elements) {
        if (!(element instanceof HTMLElement) || seen.has(element)) continue;
        seen.add(element);
        const isDocument = element === documentScroller || element === document.documentElement || element === document.body;
        const rect = isDocument ? { width: innerWidth, height: innerHeight } : element.getBoundingClientRect();
        const clientHeight = isDocument ? innerHeight : element.clientHeight;
        const scrollHeight = isDocument ? Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) : element.scrollHeight;
        const range = Math.max(0, scrollHeight - clientHeight);
        if (clientHeight < 120 || rect.width < Math.max(260, innerWidth * 0.25)) continue;
        const style = isDocument ? null : getComputedStyle(element);
        if (!(isDocument || range > 80 || /(auto|scroll|overlay)/.test(style?.overflowY || ''))) continue;
        if (excluded(element)) continue;
        const name = `${String(element.className || '')} ${element.id || ''} ${element.getAttribute?.('role') || ''}`.toLowerCase();
        const root = isDocument ? document.body : element;
        const quickCount = root.querySelectorAll(generalSelector).length;
        const typeBonus = /(docx|editor|document|content|main|scroll|sheet|grid|table)/.test(name) ? 1500 : 0;
        candidates.push({ element, root, isDocument, range, quickCount, score: quickCount * 300 + Math.min(range, 300000) + typeBonus });
      }
      return candidates.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(5, Number(options.maxTargets || 3))));
    }

    function viewportRect(target) {
      return target.isDocument
        ? { top: 0, bottom: innerHeight, left: 0, right: innerWidth, height: innerHeight }
        : target.element.getBoundingClientRect();
    }
    function nodeVisibleInTarget(node, target) {
      if (!rendered(node)) return false;
      const rect = node.getBoundingClientRect();
      const viewport = viewportRect(target);
      return rect.bottom > viewport.top && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewport.right;
    }
    function accessors(target) {
      return {
        getTop: () => target.isDocument ? window.scrollY : target.element.scrollTop,
        setTop: (value) => {
          if (target.isDocument) window.scrollTo({ top: value, behavior: 'auto' });
          else target.element.scrollTop = value;
        },
        getViewport: () => target.isDocument ? innerHeight : target.element.clientHeight,
        getScrollHeight: () => target.isDocument ? Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) : target.element.scrollHeight,
      };
    }
    function resolveOrdinal(node, text) {
      const rawExplicit =
        node.getAttribute?.('data-index') ??
        node.getAttribute?.('data-row-index') ??
        node.getAttribute?.('aria-rowindex') ??
        node.getAttribute?.('data-ordinal');
      if (rawExplicit !== null && rawExplicit !== undefined && String(rawExplicit).trim() !== '') {
        const explicit = Number(rawExplicit);
        if (Number.isFinite(explicit)) return explicit;
      }
      const sourceId = sourceIdOf(node);
      if (sourceId && ordinalBySourceId.has(String(sourceId))) return ordinalBySourceId.get(String(sourceId));
      const normalizedText = normalize(text);
      return ordinalByNormalizedText.has(normalizedText) ? ordinalByNormalizedText.get(normalizedText) : null;
    }

    function collectVisibleItems(target) {
      const root = target.isDocument ? document.body : target.element;
      const selector = selectorForSearch();
      const nodes = [...root.querySelectorAll(selector)].filter((node) => rendered(node) && !excluded(node) && nodeVisibleInTarget(node, target));
      const leafNodes = nodes.filter((node) => {
        const text = textOf(node);
        if (!text) return false;
        const descendants = [...node.querySelectorAll?.(selector) || []];
        return !descendants.some((child) => child !== node && rendered(child) && textOf(child));
      });
      const items = leafNodes.map((node) => {
        const rect = node.getBoundingClientRect();
        const text = textOf(node);
        const sourceId = sourceIdOf(node);
        const ordinal = resolveOrdinal(node, text);
        return {
          node,
          key: sourceId || `${ordinal ?? ''}|${text}`,
          sourceId,
          ordinal,
          text,
          top: rect.top,
          bottom: rect.bottom,
          visible: true,
        };
      });
      const targetBySource = targetHint?.sourceId
        ? items.find((item) => String(item.sourceId || '') === String(targetHint.sourceId))
        : null;
      const textMatches = items.filter((item) => matcher(item.text));
      const ranked = rankCandidates(textMatches.map((item) => item.node));
      const bestText = ranked[0]
        ? items.find((item) => item.node === ranked[0].node)
        : null;
      return { items, target: targetBySource || bestText || null };
    }

    function contextFor(node, target) {
      const root = target.isDocument ? document.body : target.element;
      const all = [...root.querySelectorAll(generalSelector)].filter((item) => rendered(item) && !excluded(item) && textOf(item));
      const index = all.indexOf(node);
      const start = Math.max(0, index - contextBefore);
      const end = Math.min(all.length, index + contextAfter + 1);
      let used = 0;
      const context = [];
      for (let i = start; i < end; i += 1) {
        const value = textOf(all[i]);
        if (!value) continue;
        const remaining = maxContextChars - used;
        if (remaining <= 0) break;
        const text = value.length > remaining ? `${value.slice(0, Math.max(0, remaining - 1))}…` : value;
        used += text.length;
        context.push({ relativeIndex: i - index, text });
      }
      return context;
    }

    function resultFor(target, located, strategyUsed) {
      const candidate = located.target;
      const node = candidate?.node;
      const rect = node?.getBoundingClientRect?.() || { x: 0, y: 0, width: 0, height: 0 };
      const row = node?.closest?.('tr,[role="row"]');
      const cell = node?.closest?.('td,th,[role="gridcell"],[role="cell"],[role="rowheader"],[role="columnheader"]') || node;
      const cells = row ? [...row.querySelectorAll('td,th,[role="gridcell"],[role="cell"],[role="rowheader"],[role="columnheader"]')] : [];
      const rowIndex = Number(cell?.getAttribute?.('aria-rowindex') || row?.getAttribute?.('aria-rowindex') || cell?.getAttribute?.('data-row-index') || row?.getAttribute?.('data-row-index')) || null;
      const columnIndex = Number(cell?.getAttribute?.('aria-colindex') || cell?.getAttribute?.('data-col-index')) || (cells.length ? cells.indexOf(cell) + 1 : null);
      const access = accessors(target);
      return {
        ok: true,
        found: located.found === true,
        query,
        strategyRequested: resolvedStrategy,
        strategyUsed,
        documentType,
        indexMatch: located.indexMatch === true,
        targetRendered: located.targetRendered === true,
        targetVisible: located.targetVisible === true,
        positionStable: located.positionStable === true,
        scrollTop: access.getTop(),
        target: candidate ? {
          text: candidate.text,
          sourceId: candidate.sourceId || sourceIdOf(node),
          ordinal: Number.isFinite(Number(candidate.ordinal)) ? Number(candidate.ordinal) : null,
          tagName: node?.tagName?.toLowerCase?.() || null,
          role: node?.getAttribute?.('role') || null,
          rowIndex,
          columnIndex,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        } : null,
        context: node ? contextFor(node, target) : [],
        diagnostics: {
          steps: located.steps || 0,
          initialTop: located.initialTop ?? null,
          finalTop: located.finalTop ?? Math.round(access.getTop()),
          visitedPositions: located.visitedPositions || [],
          clickUsed: false,
          keyboardUsed: false,
          visualRecognitionUsed: false,
          tokenSavingMode: true,
          virtualSeekEngine: 'alpha7',
        },
      };
    }

    const targets = discoverTargets();
    if (!targets.length) {
      return { ok: true, found: false, code: 'scroll_container_not_found', query, documentType, recommendedFallback: 'refresh_index_or_retry', retryable: true };
    }

    const diagnostics = [];
    for (const target of targets) {
      const access = accessors(target);
      const initialTop = access.getTop();
      const current = collectVisibleItems(target);
      if (resolvedStrategy !== 'scroll_only' && resolvedStrategy !== 'virtual_scroll' && current.target) {
        const directLocated = {
          found: true,
          indexMatch: Boolean(targetHint),
          targetRendered: true,
          targetVisible: nodeVisibleInTarget(current.target.node, target),
          positionStable: true,
          target: current.target,
          steps: 0,
          initialTop,
          finalTop: initialTop,
          visitedPositions: [Math.round(initialTop)],
        };
        return resultFor(target, directLocated, resolvedStrategy === 'table' ? 'table_dom' : 'direct_dom');
      }
      if (resolvedStrategy === 'dom' || resolvedStrategy === 'table') {
        diagnostics.push({ targetScore: target.score, strategy: resolvedStrategy, found: false });
        continue;
      }

      const adapter = {
        ...access,
        wait: sleep,
        observe: async () => {
          const observed = collectVisibleItems(target);
          const first = observed.items[0];
          const last = observed.items.at(-1);
          return {
            ...observed,
            signature: [
              Math.round(access.getTop()),
              Math.round(access.getScrollHeight()),
              first?.key || '',
              last?.key || '',
              observed.target?.key || '',
            ].join('|'),
          };
        },
        align: async (candidate, block) => {
          const node = candidate?.node;
          if (!node || !rendered(node)) return;
          const rect = node.getBoundingClientRect();
          const viewport = viewportRect(target);
          const desiredY = block === 'start' ? viewport.top + 16 : block === 'end' ? viewport.bottom - rect.height - 16 : viewport.top + viewport.height / 2 - rect.height / 2;
          access.setTop(access.getTop() + (rect.top - desiredY));
        },
        isVisible: (candidate) => Boolean(candidate?.node && nodeVisibleInTarget(candidate.node, target)),
      };

      const located = await seekEngine.seek(adapter, {
        targetHint,
        maxSteps,
        settleMs,
        searchFromTop,
        alignBlock: options.block || 'center',
        stableChecks: Math.max(2, Math.min(5, Number(options.stableChecks || 2))),
      });
      if (located.found) return resultFor(target, located, located.strategy);

      diagnostics.push({
        targetScore: target.score,
        found: false,
        code: located.code,
        strategy: located.strategy,
        steps: located.steps,
        initialTop: located.initialTop,
        finalTop: located.finalTop,
        indexMatch: located.indexMatch,
      });
      if (restoreOnNotFound) access.setTop(initialTop);
    }

    return {
      ok: true,
      found: false,
      code: 'virtual_scroll_seek_incomplete',
      query,
      strategyRequested: resolvedStrategy,
      documentType,
      indexMatch: Boolean(targetHint),
      targetRendered: false,
      targetVisible: false,
      positionStable: false,
      recommendedFallback: targetHint ? 'refresh_index_or_retry' : (resolvedStrategy === 'scroll_only' ? 'auto' : 'build_index_or_retry'),
      retryable: true,
      diagnostics: {
        targetsTried: targets.length,
        targetDiagnostics: diagnostics,
        clickUsed: false,
        keyboardUsed: false,
        visualRecognitionUsed: false,
        tokenSavingMode: true,
        virtualSeekEngine: 'alpha7',
      },
    };
  }
  rootScope.OpenClaudeLarkDeepReader = Object.freeze({ frameScan, frameLocate, frameProbe, frameScanSession, frameSessionLatest, frameSessionChunk });
})(globalThis);
