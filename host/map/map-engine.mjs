import crypto from 'node:crypto';
import { MapStore } from './map-store.mjs';
import { BuildLock } from './build-lock.mjs';
import { pageKeyFor } from './page-key.mjs';
import {
  NAVIGATION_MAP_SCHEMA_VERSION,
  NAVIGATION_MAP_RUNTIME,
  compactMapStatus,
  validateNavigationMap,
} from './map-schema.mjs';
import { adapterForPage } from '../adapters/adapter-router.mjs';
import { locateInMap, resolveAnchor } from '../search/navigation-search.mjs';

function nowIso() { return new Date().toISOString(); }

// Freshness signal for reuse: the page title. It is a general, cost-free content
// signal already carried on every request (no extra page probe), so a persisted
// map is only reused when the current page still shows the same title. This
// catches same-tab content swaps that the URL cannot — e.g. YouTube autoplay,
// where pageKey collides (query params are normalized away) but the title
// changes per video. Strips a leading "(N)" notification counter so unread
// badges don't force needless rebuilds.
function normalizeTitle(title) {
  return String(title || '')
    // Strip zero-width / bidi / word-joiner / invisible chars: Lark injects these
    // into titles and the sequence varies per capture, so without stripping them
    // the SAME document reads as "changed" and forces a needless rebuild.
    .replace(/[​-‏‪-‮⁠-⁤﻿]/g, '')
    .replace(/^\(\d+\)\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function titleAllowsReuse(storedTitle, currentTitle) {
  const stored = normalizeTitle(storedTitle);
  const current = normalizeTitle(currentTitle);
  // No title signal on one side → keep prior behavior (don't block reuse).
  if (!stored || !current) return true;
  return stored === current;
}

// Ready-to-render notice emitted on the browser_map result when the map had to
// be rebuilt because the page silently changed under the same tab (e.g. video
// autoplay). The assistant surfaces this string verbatim as its first line, so
// the "page changed" signal is deterministic and needs no per-turn prompt rule.
function formatPageChangeNotice(previousTitle, currentTitle) {
  const clip = (value) => {
    const text = String(value || '').trim();
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  };
  return `⚠️ 页面已变：当前是「${clip(currentTitle)}」，此前是「${clip(previousTitle)}」`;
}

function mapHandleFor(pageKey, version) {
  const digest = crypto.createHash('sha256').update(pageKey).digest('hex').slice(0, 16);
  return `map:${digest}:v${version}`;
}


function compactBuildFailure(pageKey, page, adapter, snapshot = {}) {
  return {
    ok: false,
    code: String(snapshot.code || 'map_build_failed'),
    pageKey,
    page: snapshot.page || page || null,
    adapter: snapshot.adapter || adapter?.id || null,
    mapCoverage: snapshot.mapCoverage || null,
    diagnostics: Array.isArray(snapshot.diagnostics) ? snapshot.diagnostics.slice(0, 8) : [],
    failedAt: new Date().toISOString(),
  };
}

function optionalFiniteNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
}

function normalizeAnchor(raw, index) {
  const kind = String(raw.kind || raw.type || 'region');
  const label = String(raw.label || raw.title || raw.textPrefix || raw.text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return {
    id: String(raw.id || `anchor:${index}`),
    locator: String(raw.locator || raw.id || `anchor:${index}`),
    kind,
    label,
    ordinal: optionalFiniteNumber(raw.ordinal ?? raw.number),
    parentId: raw.parentId ? String(raw.parentId) : null,
    order: optionalFiniteNumber(raw.order) ?? index,
    adapter: String(raw.adapter || 'generic_dom'),
    confidence: Math.max(0, Math.min(1, Number(raw.confidence ?? 0.8))),
    frameId: Number(raw.frameId || 0),
    locatorEvidence: raw.locatorEvidence && typeof raw.locatorEvidence === 'object' ? raw.locatorEvidence : {},
    range: raw.range && typeof raw.range === 'object' ? raw.range : null,
    flags: raw.flags && typeof raw.flags === 'object' ? raw.flags : {},
    searchText: Array.isArray(raw.searchText) ? raw.searchText.map(String).slice(0, 8) : [],
  };
}

class MapEngine {
  constructor(options = {}) {
    this.store = options.store || new MapStore(options);
    this.lock = options.lock || new BuildLock();
  }

  identify(page) {
    const pageKey = pageKeyFor(page);
    return { pageKey, adapter: adapterForPage(page) };
  }

  getByPage(page) {
    const { pageKey } = this.identify(page);
    return this.store.read(pageKey);
  }

  getByPageKey(pageKey) { return this.store.read(pageKey); }

  async getOrCreate(page, builder, options = {}) {
    const { pageKey, adapter } = this.identify(page);
    if (!options.refresh) {
      const existing = this.store.read(pageKey);
      if (existing.ok && titleAllowsReuse(existing.map?.page?.title, page?.title)) return { ok: true, reused: true, map: existing.map, status: compactMapStatus(existing.map) };
      const previousFailure = this.store.readFailure?.(pageKey);
      if (previousFailure?.ok && titleAllowsReuse(previousFailure.failure?.page?.title, page?.title)) return { ...previousFailure.failure, reused: true, retryRequiresExplicitRefresh: true };
    }
    return this.lock.run(pageKey, async () => {
      if (!options.refresh) {
        const existing = this.store.read(pageKey);
        if (existing.ok && titleAllowsReuse(existing.map?.page?.title, page?.title)) return { ok: true, reused: true, map: existing.map, status: compactMapStatus(existing.map) };
        const previousFailure = this.store.readFailure?.(pageKey);
        if (previousFailure?.ok && titleAllowsReuse(previousFailure.failure?.page?.title, page?.title)) return { ...previousFailure.failure, reused: true, retryRequiresExplicitRefresh: true };
      }
      const previous = this.store.read(pageKey);
      // Silent same-tab content swap: a stored map existed but the page title no
      // longer matches (title guard blocked reuse, not an explicit refresh).
      const pageTitleChanged = !options.refresh && previous.ok && !titleAllowsReuse(previous.map?.page?.title, page?.title);
      const snapshot = await builder({ page, pageKey, adapter, previous: previous.ok ? previous.map : null });
      if (!snapshot?.ok) {
        const failure = compactBuildFailure(pageKey, page, adapter, snapshot || {});
        if (!previous.ok) this.store.writeFailure?.(pageKey, failure);
        return { ...failure, retryRequiresExplicitRefresh: true };
      }
      if (snapshot.mapCoverage?.status && !['complete', 'complete_with_warnings'].includes(snapshot.mapCoverage.status)) {
        const failure = compactBuildFailure(pageKey, page, adapter, { ...snapshot, code: 'map_build_incomplete' });
        if (!previous.ok) this.store.writeFailure?.(pageKey, failure);
        return { ...failure, retryRequiresExplicitRefresh: true };
      }
      const version = previous.ok ? Number(previous.map.mapVersion || 0) + 1 : 1;
      const createdAt = previous.ok ? previous.map.createdAt : nowIso();
      const map = {
        schemaVersion: NAVIGATION_MAP_SCHEMA_VERSION,
        runtime: NAVIGATION_MAP_RUNTIME,
        status: 'ready',
        pageKey,
        mapHandle: mapHandleFor(pageKey, version),
        mapVersion: version,
        createdAt,
        updatedAt: nowIso(),
        page: {
          title: String(snapshot.page?.title || page.title || ''),
          url: String(snapshot.page?.url || page.url || ''),
          pageType: String(snapshot.page?.pageType || page.pageType || ''),
          lastKnownTabId: Number(snapshot.page?.tabId || page.tabId || 0) || null,
        },
        adapter: snapshot.adapter || adapter.id,
        capabilities: snapshot.capabilities || adapter.capabilities,
        revision: snapshot.revision || { state: 'unknown' },
        kernel: snapshot.kernel || { runtime: 'universal-map-kernel-v1', schemaVersion: 1 },
        mapCoverage: snapshot.mapCoverage || { status: 'complete', evidence: {} },
        // Per-stage build trace (evidence → merge → numbered anchors). Persisted
        // locally for missing-ordinal diagnosis; never returned to the model in full.
        kernelTrace: snapshot.kernelTrace || null,
        anchors: (snapshot.anchors || []).map(normalizeAnchor),
        diagnostics: (snapshot.diagnostics || []).slice(0, 40),
      };
      const validation = validateNavigationMap(map);
      if (!validation.ok) return { ok: false, code: 'map_validation_failed', errors: validation.errors };
      this.store.write(map);
      // Body text persists beside the map under the same refresh contract;
      // reads are then served from disk with zero page interaction.
      if (Array.isArray(snapshot.contentBlocks) && snapshot.contentBlocks.length) {
        try { this.store.writeContent?.(pageKey, { mapVersion: version, blocks: snapshot.contentBlocks }); } catch {}
      }
      const result = { ok: true, reused: false, refreshed: options.refresh === true, map, status: compactMapStatus(map) };
      if (pageTitleChanged) {
        const previousTitle = String(previous.map?.page?.title || '');
        const currentTitle = String(map.page.title || '');
        result.pageChanged = { previousTitle, currentTitle };
        result.pageChangeNotice = formatPageChangeNotice(previousTitle, currentTitle);
      }
      return result;
    });
  }

  locate(map, query, options = {}) { return locateInMap(map, query, options); }
  resolve(map, target) { return resolveAnchor(map, target); }
}

export { MapEngine, normalizeAnchor, mapHandleFor };
