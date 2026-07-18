/* Generic virtual-scroll seek engine shared by Lark locating and future automation adapters. */
((root) => {
  const DEFAULTS = Object.freeze({
    maxSteps: 96,
    settleMs: 80,
    stableChecks: 2,
    stableTolerancePx: 3,
    minStepPx: 180,
    maxStepViewports: 8,
    alignBlock: 'center',
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
  const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

  function normalizeAnchors(rawAnchors = [], maxTop = Infinity) {
    const seen = new Set();
    return rawAnchors
      .map((anchor) => ({
        ordinal: finite(anchor?.ordinal),
        top: finite(anchor?.scrollTop ?? anchor?.virtualTop),
        relativePosition: finite(anchor?.relativePosition),
        sourceId: anchor?.sourceId || null,
      }))
      .filter((anchor) => anchor.ordinal !== null && (anchor.top !== null || anchor.relativePosition !== null))
      .map((anchor) => ({
        ...anchor,
        top: anchor.top !== null ? clamp(anchor.top, 0, maxTop) : clamp(anchor.relativePosition * maxTop, 0, maxTop),
      }))
      .filter((anchor) => {
        const key = `${anchor.ordinal}|${Math.round(anchor.top)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) => left.ordinal - right.ordinal || left.top - right.top);
  }

  function interpolateOrdinalTop(targetOrdinal, anchors, maxTop) {
    const ordinal = finite(targetOrdinal);
    if (ordinal === null || !anchors.length) return null;
    if (anchors.length === 1) return clamp(anchors[0].top, 0, maxTop);

    let lower = null;
    let upper = null;
    for (const anchor of anchors) {
      if (anchor.ordinal <= ordinal) lower = anchor;
      if (anchor.ordinal >= ordinal) { upper = anchor; break; }
    }
    lower ||= anchors[0];
    upper ||= anchors.at(-1);
    if (lower.ordinal === upper.ordinal) return clamp(lower.top, 0, maxTop);
    const ratio = (ordinal - lower.ordinal) / (upper.ordinal - lower.ordinal);
    return clamp(lower.top + (upper.top - lower.top) * ratio, 0, maxTop);
  }

  function estimateInitialTop(hint = {}, metrics = {}) {
    const viewport = Math.max(1, finite(metrics.viewport) || 1);
    const maxTop = Math.max(0, finite(metrics.maxTop) ?? Math.max(0, (finite(metrics.scrollHeight) || viewport) - viewport));
    const indexedMaxTop = Math.max(1, finite(hint.indexedMaxTop) || finite(hint.indexedScrollHeight) || maxTop || 1);
    const currentScale = maxTop > 0 ? maxTop / indexedMaxTop : 1;
    const targetOrdinal = finite(hint.ordinal);
    const anchors = normalizeAnchors(hint.anchors || [], indexedMaxTop)
      .map((anchor) => ({ ...anchor, top: clamp(anchor.top * currentScale, 0, maxTop) }));

    let estimate = interpolateOrdinalTop(targetOrdinal, anchors, maxTop);
    if (estimate === null && finite(hint.virtualTop) !== null) estimate = finite(hint.virtualTop) * currentScale;
    if (estimate === null && finite(hint.relativePosition) !== null) estimate = finite(hint.relativePosition) * maxTop;
    if (estimate === null && targetOrdinal !== null && finite(hint.totalBlocks) > 1) {
      estimate = (targetOrdinal / Math.max(1, finite(hint.totalBlocks) - 1)) * maxTop;
    }
    if (estimate === null) estimate = finite(metrics.currentTop) || 0;
    return clamp(estimate - viewport * 0.35, 0, maxTop);
  }

  function ordinalRange(items = []) {
    const ordinals = items.map((item) => finite(item?.ordinal)).filter((value) => value !== null);
    if (!ordinals.length) return null;
    return { start: Math.min(...ordinals), end: Math.max(...ordinals) };
  }

  function estimatePixelsPerOrdinal(observation, hint, viewport) {
    const items = observation?.items || [];
    const ordered = items
      .map((item) => ({ ordinal: finite(item?.ordinal), top: finite(item?.top) }))
      .filter((item) => item.ordinal !== null && item.top !== null)
      .sort((a, b) => a.ordinal - b.ordinal);
    if (ordered.length >= 2) {
      const first = ordered[0];
      const last = ordered.at(-1);
      const deltaOrdinal = last.ordinal - first.ordinal;
      if (deltaOrdinal > 0) return clamp(Math.abs(last.top - first.top) / deltaOrdinal, 4, viewport * 2);
    }
    const anchors = normalizeAnchors(hint?.anchors || [], Math.max(1, finite(hint?.indexedMaxTop) || 1));
    if (anchors.length >= 2) {
      let best = null;
      for (let index = 1; index < anchors.length; index += 1) {
        const left = anchors[index - 1];
        const right = anchors[index];
        const deltaOrdinal = right.ordinal - left.ordinal;
        if (deltaOrdinal <= 0) continue;
        const candidate = Math.abs(right.top - left.top) / deltaOrdinal;
        if (candidate > 0 && (!best || candidate < best)) best = candidate;
      }
      if (best) return clamp(best, 4, viewport * 2);
    }
    return Math.max(12, viewport / 18);
  }

  function chooseBracketTop(targetOrdinal, range, currentTop, brackets, maxTop) {
    if (!range || finite(targetOrdinal) === null) return null;
    const target = finite(targetOrdinal);
    if (target > range.end) brackets.low = { top: currentTop, ordinal: range.end };
    else if (target < range.start) brackets.high = { top: currentTop, ordinal: range.start };
    if (brackets.low && brackets.high && brackets.high.top > brackets.low.top + 2) {
      const ordinalSpan = brackets.high.ordinal - brackets.low.ordinal;
      if (ordinalSpan > 0) {
        const ratio = clamp((target - brackets.low.ordinal) / ordinalSpan, 0.05, 0.95);
        return clamp(brackets.low.top + (brackets.high.top - brackets.low.top) * ratio, 0, maxTop);
      }
      return clamp((brackets.low.top + brackets.high.top) / 2, 0, maxTop);
    }
    return null;
  }

  async function waitForStable(adapter, options, previousSignature = '') {
    const stableChecks = Math.max(1, Number(options.stableChecks || DEFAULTS.stableChecks));
    let stable = 0;
    let lastSignature = previousSignature;
    let latest = null;
    for (let check = 0; check < Math.max(stableChecks + 2, 3); check += 1) {
      await (adapter.wait ? adapter.wait(options.settleMs) : sleep(options.settleMs));
      latest = await adapter.observe();
      const signature = String(latest?.signature || `${Math.round(adapter.getTop())}|${Math.round(adapter.getScrollHeight())}`);
      stable = signature === lastSignature ? stable + 1 : 0;
      lastSignature = signature;
      if (stable >= stableChecks) break;
    }
    return { observation: latest || await adapter.observe(), signature: lastSignature, stable: stable >= stableChecks };
  }

  async function verifyTarget(adapter, target, options) {
    let stable = 0;
    let latest = target;
    let previousKey = '';
    const checks = Math.max(2, Number(options.stableChecks || DEFAULTS.stableChecks));
    for (let index = 0; index < checks + 2; index += 1) {
      if (adapter.align) await adapter.align(latest, options.alignBlock || DEFAULTS.alignBlock);
      await (adapter.wait ? adapter.wait(options.settleMs) : sleep(options.settleMs));
      const observation = await adapter.observe();
      latest = observation?.target || latest;
      const visible = Boolean(latest && (adapter.isVisible ? adapter.isVisible(latest) : latest.visible !== false));
      const key = latest ? String(latest.key || latest.sourceId || latest.text || '') : '';
      if (visible && key && key === previousKey) stable += 1;
      else stable = visible ? 1 : 0;
      previousKey = key;
      if (stable >= checks) {
        return { target: latest, targetRendered: true, targetVisible: true, positionStable: true, observation };
      }
    }
    return {
      target: latest || null,
      targetRendered: Boolean(latest),
      targetVisible: Boolean(latest && (adapter.isVisible ? adapter.isVisible(latest) : latest.visible !== false)),
      positionStable: false,
      observation: null,
    };
  }

  async function seek(adapter, rawOptions = {}) {
    const options = { ...DEFAULTS, ...rawOptions };
    const maxSteps = Math.max(1, Math.min(5000, Number(options.maxSteps || DEFAULTS.maxSteps)));
    const viewport = Math.max(1, finite(adapter.getViewport()) || 1);
    const scrollHeight = Math.max(viewport, finite(adapter.getScrollHeight()) || viewport);
    const maxTop = Math.max(0, scrollHeight - viewport);
    const hasTargetHint = Boolean(options.targetHint && Object.keys(options.targetHint).length);
    const initialTop = options.searchFromTop === true && !hasTargetHint ? 0 : estimateInitialTop(options.targetHint || {}, {
      viewport,
      scrollHeight,
      maxTop,
      currentTop: adapter.getTop(),
    });
    const visited = [];
    const brackets = { low: null, high: null };
    let direction = 1;
    let radialStep = Math.max(viewport * 0.75, Number(options.minStepPx || DEFAULTS.minStepPx));
    let lastSignature = '';
    let previousTop = null;
    let target = null;
    let lastObservation = null;

    adapter.setTop(initialTop);
    for (let step = 0; step < maxSteps; step += 1) {
      const stableResult = await waitForStable(adapter, options, lastSignature);
      lastObservation = stableResult.observation;
      lastSignature = stableResult.signature;
      const currentTop = clamp(adapter.getTop(), 0, Math.max(0, adapter.getScrollHeight() - adapter.getViewport()));
      visited.push(Math.round(currentTop));
      if (lastObservation?.target) {
        target = lastObservation.target;
        const verified = await verifyTarget(adapter, target, options);
        return {
          ok: true,
          found: verified.targetRendered && verified.targetVisible && verified.positionStable,
          indexMatch: Boolean(options.targetHint?.ordinal !== undefined || options.targetHint?.sourceId || options.targetHint?.virtualTop !== undefined),
          targetRendered: verified.targetRendered,
          targetVisible: verified.targetVisible,
          positionStable: verified.positionStable,
          target: verified.target,
          observation: verified.observation || lastObservation,
          initialTop: Math.round(initialTop),
          finalTop: Math.round(adapter.getTop()),
          steps: step + 1,
          visitedPositions: visited,
          strategy: hasTargetHint ? 'indexed_virtual_seek' : 'adaptive_virtual_seek',
        };
      }

      const currentMaxTop = Math.max(0, adapter.getScrollHeight() - adapter.getViewport());
      const range = ordinalRange(lastObservation?.items || []);
      const targetOrdinal = finite(options.targetHint?.ordinal);
      let nextTop = chooseBracketTop(targetOrdinal, range, currentTop, brackets, currentMaxTop);

      if (nextTop === null && range && targetOrdinal !== null) {
        const pixelsPerOrdinal = estimatePixelsPerOrdinal(lastObservation, options.targetHint || {}, viewport);
        const centerOrdinal = (range.start + range.end) / 2;
        const deltaOrdinal = targetOrdinal - centerOrdinal;
        const maxStep = viewport * Math.max(1, Number(options.maxStepViewports || DEFAULTS.maxStepViewports));
        nextTop = clamp(currentTop + clamp(deltaOrdinal * pixelsPerOrdinal, -maxStep, maxStep), 0, currentMaxTop);
      }

      if (nextTop === null) {
        if (options.searchFromTop === true && !options.targetHint && step === 0) nextTop = 0;
        else {
          const offset = Math.ceil((step + 1) / 2) * radialStep * direction;
          nextTop = clamp(initialTop + offset, 0, currentMaxTop);
          direction *= -1;
          if (direction > 0) radialStep = Math.min(currentMaxTop || radialStep, radialStep * 1.45);
        }
      }

      if (previousTop !== null && Math.abs(nextTop - currentTop) <= Number(options.stableTolerancePx || DEFAULTS.stableTolerancePx)) {
        if (currentTop <= 2 && nextTop <= 2) nextTop = Math.min(currentMaxTop, currentTop + viewport * 0.8);
        else if (currentTop >= currentMaxTop - 2) nextTop = Math.max(0, currentTop - viewport * 0.8);
        else nextTop = clamp(currentTop + (direction > 0 ? 1 : -1) * viewport * 0.6, 0, currentMaxTop);
      }
      previousTop = currentTop;
      adapter.setTop(nextTop);
    }

    return {
      ok: true,
      found: false,
      indexMatch: Boolean(options.targetHint?.ordinal !== undefined || options.targetHint?.sourceId || options.targetHint?.virtualTop !== undefined),
      targetRendered: false,
      targetVisible: false,
      positionStable: false,
      target: null,
      observation: lastObservation,
      initialTop: Math.round(initialTop),
      finalTop: Math.round(adapter.getTop()),
      steps: maxSteps,
      visitedPositions: visited,
      strategy: hasTargetHint ? 'indexed_virtual_seek' : 'adaptive_virtual_seek',
      code: 'virtual_scroll_seek_incomplete',
    };
  }

  root.OpenClaudeVirtualScrollSeek = Object.freeze({
    seek,
    estimateInitialTop,
    normalizeAnchors,
    interpolateOrdinalTop,
    ordinalRange,
  });
})(globalThis);
