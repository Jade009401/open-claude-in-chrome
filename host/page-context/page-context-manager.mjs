import crypto from 'node:crypto';

const CURRENT_PAGE_PATTERNS = [
  /当前(?:浏览器)?(?:页面|网页|标签页)/i,
  /现在(?:这个|打开的)?(?:页面|网页|标签页)/i,
  /这个(?:浏览器)?(?:页面|网页|标签页)/i,
  /\b(?:this|current|active)\s+(?:browser\s+)?(?:page|tab)\b/i,
];

const STOP_TOKENS = new Set([
  'the', 'this', 'that', 'page', 'tab', 'browser', 'current', 'active', 'open',
  'find', 'query', 'search', 'check', 'look', 'read', 'show', 'please', 'help',
  '一下', '帮我', '查一下', '查询', '查找', '页面', '网页', '标签页', '浏览器', '里面', '服务',
]);

function normalizeSearchText(value = '') {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_./:?#[\]{}()]+/g, ' ')
    .replace(/[-]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokenize(value = '') {
  const normalized = normalizeSearchText(value);
  if (!normalized) return [];
  const output = [];
  const seen = new Set();
  for (const token of normalized.split(/\s+/)) {
    if (!token || STOP_TOKENS.has(token)) continue;
    if (token.length < 2 && !/\d/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    output.push(token);
  }
  return output;
}

function normalizeIdentity(input = {}) {
  const tabId = Number(input.tabId || 0);
  let origin = null;
  let pageKey = null;
  let host = null;
  let pathname = null;
  try {
    const parsed = new URL(String(input.url || ''));
    origin = parsed.origin;
    host = parsed.hostname;
    pathname = parsed.pathname;
    pageKey = `${parsed.origin}${parsed.pathname}`;
  } catch {}
  const title = String(input.title || 'Untitled');
  const url = String(input.url || '');
  return {
    tabId,
    windowId: Number(input.windowId || 0) || null,
    title,
    url,
    origin,
    host,
    pathname,
    pageKey,
    status: input.status || null,
    active: input.active === true,
    tokens: [...new Set([...tokenize(title), ...tokenize(url), ...tokenize(host || '')])],
  };
}

function makeId(prefix = 'task') {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function wantsCurrentPage(query = '') {
  const value = String(query || '');
  return CURRENT_PAGE_PATTERNS.some((pattern) => pattern.test(value));
}

function scoreCandidate(identity, queryTokens, recentEntry, options = {}) {
  if (!identity?.tabId) return Number.NEGATIVE_INFINITY;
  const schemeAllowed = /^https?:/i.test(identity.url || '');
  if (!schemeAllowed && options.allowNonHttp !== true) return Number.NEGATIVE_INFINITY;

  const candidateTokens = new Set(identity.tokens || []);
  let score = 0;
  let matchedTokens = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) {
      score += 14;
      matchedTokens += 1;
      continue;
    }
    if (token.length >= 3) {
      const partial = [...candidateTokens].some((candidate) => candidate.includes(token) || token.includes(candidate));
      if (partial) {
        score += 6;
        matchedTokens += 1;
      }
    }
  }

  if (recentEntry) {
    score += Math.min(30, 10 + Number(recentEntry.useCount || 0) * 2);
    if (recentEntry.identity?.pageKey && recentEntry.identity.pageKey === identity.pageKey) score += 20;
    if (recentEntry.identity?.origin && recentEntry.identity.origin === identity.origin) score += 8;
  }
  if (identity.active) score += options.preferActive ? 10 : 1;
  if (options.preferredOrigin && identity.origin === options.preferredOrigin) score += 24;
  if (options.preferredPageKey && identity.pageKey === options.preferredPageKey) score += 36;
  return { score, matchedTokens };
}

export class PageContextManager {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.implicitIdleMs = Math.max(1000, Number(options.implicitIdleMs || 20000));
    this.recentPageTtlMs = Math.max(60000, Number(options.recentPageTtlMs || 6 * 60 * 60 * 1000));
    this.maxRecentPages = Math.max(5, Number(options.maxRecentPages || 50));
    this.contexts = new Map();
    this.recentPages = new Map();
    this.activeTaskId = null;
    this.pinnedContextId = null;
  }

  remember(identity, metadata = {}) {
    const normalized = normalizeIdentity(identity);
    if (!normalized.tabId) return null;
    const now = this.now();
    const existing = this.recentPages.get(normalized.tabId);
    const entry = {
      identity: normalized,
      firstUsedAt: existing?.firstUsedAt || now,
      lastUsedAt: now,
      useCount: Number(existing?.useCount || 0) + 1,
      lastSource: metadata.source || existing?.lastSource || null,
      alias: metadata.alias || existing?.alias || null,
    };
    this.recentPages.set(normalized.tabId, entry);
    this.pruneRecent();
    return entry;
  }

  pruneRecent() {
    const now = this.now();
    for (const [tabId, entry] of this.recentPages) {
      if (now - entry.lastUsedAt > this.recentPageTtlMs) this.recentPages.delete(tabId);
    }
    if (this.recentPages.size <= this.maxRecentPages) return;
    const ordered = [...this.recentPages.entries()].sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt);
    this.recentPages = new Map(ordered.slice(0, this.maxRecentPages));
  }

  create(identity, options = {}) {
    const normalized = normalizeIdentity(identity);
    if (!normalized.tabId) throw new Error('valid tabId is required');
    const mode = options.mode === 'pinned' ? 'pinned' : 'task';
    const id = options.id || makeId(mode === 'pinned' ? 'page' : 'task');
    const now = this.now();
    const context = {
      id,
      alias: options.alias || null,
      mode,
      implicit: options.implicit === true,
      navigationPolicy: options.navigationPolicy || 'same_page',
      selectionMode: options.selectionMode || (options.tabId ? 'explicit_tab' : 'active_default'),
      createdAt: now,
      lastUsedAt: now,
      identity: normalized,
      status: 'active',
      childTabIds: [],
    };
    this.contexts.set(id, context);
    if (context.selectionMode !== 'active_default' || mode === 'pinned') {
      this.remember(normalized, { source: mode, alias: context.alias });
    }
    if (mode === 'pinned') this.pinnedContextId = id;
    else this.activeTaskId = id;
    return this.serialize(context);
  }

  serialize(context) {
    if (!context) return null;
    const { tokens, ...identity } = context.identity || {};
    return {
      id: context.id,
      alias: context.alias,
      mode: context.mode,
      implicit: context.implicit,
      navigationPolicy: context.navigationPolicy,
      selectionMode: context.selectionMode || 'active_default',
      createdAt: new Date(context.createdAt).toISOString(),
      lastUsedAt: new Date(context.lastUsedAt).toISOString(),
      status: context.status,
      ...identity,
      childTabIds: [...(context.childTabIds || [])],
    };
  }

  serializeRecent(entry) {
    if (!entry) return null;
    const { tokens, ...identity } = entry.identity || {};
    return {
      ...identity,
      firstUsedAt: new Date(entry.firstUsedAt).toISOString(),
      lastUsedAt: new Date(entry.lastUsedAt).toISOString(),
      useCount: entry.useCount,
      lastSource: entry.lastSource,
      alias: entry.alias,
    };
  }

  get(id) {
    return id ? this.contexts.get(id) || null : null;
  }

  current() {
    const task = this.get(this.activeTaskId);
    if (task) return task;
    return this.get(this.pinnedContextId);
  }

  touch(context) {
    if (context) {
      context.lastUsedAt = this.now();
      this.remember(context.identity, { source: context.mode, alias: context.alias });
    }
    return context;
  }

  expireImplicit() {
    const context = this.get(this.activeTaskId);
    if (!context || !context.implicit) return false;
    if (this.now() - context.lastUsedAt <= this.implicitIdleMs) return false;
    this.end(context.id, 'implicit_idle_timeout');
    return true;
  }

  end(id = this.activeTaskId, reason = 'completed') {
    const context = this.get(id);
    if (!context) return null;
    context.status = reason;
    this.remember(context.identity, { source: reason, alias: context.alias });
    this.contexts.delete(id);
    if (this.activeTaskId === id) this.activeTaskId = null;
    if (this.pinnedContextId === id) this.pinnedContextId = null;
    return this.serialize(context);
  }

  unpin() {
    if (!this.pinnedContextId) return null;
    return this.end(this.pinnedContextId, 'unpinned');
  }

  addChildTab(taskId, tabId) {
    const context = this.get(taskId || this.activeTaskId);
    if (!context || !tabId) return false;
    if (!context.childTabIds.includes(tabId)) context.childTabIds.push(tabId);
    this.touch(context);
    return true;
  }

  removeChildTab(tabId) {
    this.recentPages.delete(Number(tabId));
    for (const context of this.contexts.values()) {
      context.childTabIds = context.childTabIds.filter((id) => id !== tabId);
    }
  }

  validateIdentity(context, currentIdentity) {
    if (currentIdentity?.ok === false) {
      return {
        ok: false,
        code: currentIdentity.code || 'target_page_closed',
        context: this.serialize(context),
        current: currentIdentity,
      };
    }
    const current = normalizeIdentity(currentIdentity);
    if (!current.tabId) return { ok: false, code: 'target_page_closed', context: this.serialize(context) };
    if (current.tabId !== context.identity.tabId) {
      return { ok: false, code: 'target_tab_mismatch', context: this.serialize(context), current };
    }
    const policy = context.navigationPolicy || 'same_page';
    if (policy === 'same_page' && context.identity.pageKey && current.pageKey !== context.identity.pageKey) {
      return { ok: false, code: 'target_page_changed', context: this.serialize(context), current };
    }
    if (policy === 'same_origin' && context.identity.origin && current.origin !== context.identity.origin) {
      return { ok: false, code: 'target_origin_changed', context: this.serialize(context), current };
    }
    context.identity = current;
    this.touch(context);
    return { ok: true, context: this.serialize(context), identity: current };
  }

  async listOpenPages(captureFn) {
    const result = await captureFn({ list: true });
    const tabs = Array.isArray(result?.tabs) ? result.tabs : [];
    return tabs.map((tab) => normalizeIdentity(tab)).filter((tab) => tab.tabId);
  }

  async recoverOpenPage(captureFn, options = {}) {
    const query = String(options.query || options.pageHint || '');
    if (wantsCurrentPage(query)) return null;
    const queryTokens = tokenize(query);
    if (!queryTokens.length && options.preferRecent !== true) return null;
    const pages = await this.listOpenPages(captureFn);
    if (!pages.length) return null;

    this.pruneRecent();
    const ranked = pages.map((identity) => {
      const recent = this.recentPages.get(identity.tabId) || null;
      const scored = scoreCandidate(identity, queryTokens, recent, {
        preferActive: false,
        preferredOrigin: options.preferredOrigin,
        preferredPageKey: options.preferredPageKey,
      });
      return { identity, recent, ...scored };
    }).filter((item) => Number.isFinite(item.score));
    const semanticRanked = ranked.filter((item) => item.matchedTokens > 0);
    let pool = semanticRanked;
    let recoveryMode = 'semantic';
    if (!pool.length && options.preferRecent === true) {
      pool = ranked.filter((item) => item.recent).sort((a, b) => b.recent.lastUsedAt - a.recent.lastUsedAt || b.recent.useCount - a.recent.useCount);
      recoveryMode = 'recent_continuity';
    }
    if (!pool.length) return null;
    if (recoveryMode === 'semantic') {
      pool.sort((a, b) => b.score - a.score || b.matchedTokens - a.matchedTokens || Number(b.identity.active) - Number(a.identity.active));
    }
    const best = pool[0];
    if (!best) return null;
    if (recoveryMode === 'semantic' && (best.matchedTokens < 1 || best.score < 12)) return null;

    const active = ranked.find((item) => item.identity.active);
    if (recoveryMode === 'semantic' && active && active.identity.tabId !== best.identity.tabId && active.matchedTokens === best.matchedTokens && active.score >= best.score - 3) {
      return null;
    }

    this.remember(best.identity, { source: recoveryMode === 'semantic' ? 'semantic_tab_recovery' : 'recent_page_continuity' });
    return {
      ok: true,
      source: recoveryMode === 'recent_continuity' ? 'recent_page_continuity' : (best.recent ? 'recent_page_recovery' : 'open_tab_semantic_match'),
      identity: best.identity,
      diagnostics: {
        queryTokens,
        score: best.score,
        matchedTokens: best.matchedTokens,
        candidateCount: ranked.length,
        activeTabId: active?.identity?.tabId || null,
        reusedExistingTab: true,
        openedNewTab: false,
        recoveryMode,
      },
    };
  }

  async start(captureFn, options = {}) {
    let identity = null;
    let selectionMode = 'active_default';
    if (options.tabId) {
      identity = await captureFn({ tabId: Number(options.tabId) });
      selectionMode = 'explicit_tab';
    } else if (options.query || options.pageHint) {
      const recovered = await this.recoverOpenPage(captureFn, options);
      if (recovered?.identity) {
        identity = recovered.identity;
        selectionMode = 'semantic_recovery';
      } else {
        identity = await captureFn({ active: true });
      }
    } else {
      identity = await captureFn({ active: true });
    }
    if (!identity?.ok || !identity.tabId) return identity || { ok: false, code: 'page_capture_failed' };
    const context = this.create(identity, {
      mode: options.mode || 'task',
      alias: options.alias,
      implicit: options.implicit === true,
      navigationPolicy: options.navigationPolicy || 'same_page',
      selectionMode,
    });
    return { ok: true, action: context.mode === 'pinned' ? 'page_pinned' : 'task_started', context };
  }

  async resolve(captureFn, options = {}) {
    if (options.tabId) {
      const identity = await captureFn({ tabId: Number(options.tabId) });
      if (identity?.ok) this.remember(identity, { source: 'explicit_tab' });
      return identity?.ok ? { ok: true, source: 'explicit_tab', identity: normalizeIdentity(identity) } : identity;
    }

    this.expireImplicit();
    let context = options.taskId ? this.get(options.taskId) : this.current();
    if (context) {
      if (options.allowSemanticRebind !== false && context.selectionMode === 'active_default' && ((options.query || options.pageHint) || options.preferRecent === true) && !wantsCurrentPage(options.query || options.pageHint || '')) {
        const recovered = await this.recoverOpenPage(captureFn, options);
        if (recovered?.ok && recovered.identity.tabId !== context.identity.tabId) {
          context.identity = normalizeIdentity(recovered.identity);
          context.selectionMode = 'semantic_recovery';
          context.lastUsedAt = this.now();
          this.remember(context.identity, { source: 'semantic_task_rebind', alias: context.alias });
        }
      }
      const current = await captureFn({ tabId: context.identity.tabId });
      const validated = this.validateIdentity(context, current);
      if (!validated.ok) return validated;
      return {
        ok: true,
        source: context.mode === 'pinned' ? 'pinned_page' : (context.implicit ? 'implicit_task' : 'task_context'),
        taskId: context.mode === 'task' ? context.id : null,
        context: this.serialize(context),
        identity: validated.identity,
      };
    }

    if (options.allowRecentRecovery !== false) {
      const recovered = await this.recoverOpenPage(captureFn, options);
      if (recovered?.ok) {
        if (options.autoStart === false) return recovered;
        const created = this.create(recovered.identity, {
          mode: 'task',
          implicit: true,
          navigationPolicy: options.navigationPolicy || 'same_page',
          selectionMode: 'semantic_recovery',
        });
        return {
          ...recovered,
          taskId: created.id,
          context: created,
        };
      }
    }

    if (options.autoStart === false) return { ok: false, code: 'page_context_missing' };
    const started = await this.start(captureFn, {
      mode: 'task',
      implicit: true,
      navigationPolicy: options.navigationPolicy || 'same_page',
      query: wantsCurrentPage(options.query || '') ? '' : options.query,
      pageHint: options.pageHint,
    });
    if (!started?.ok) return started;
    context = this.get(started.context.id);
    return {
      ok: true,
      source: 'implicit_task',
      taskId: context.id,
      context: this.serialize(context),
      identity: context.identity,
    };
  }

  status() {
    this.expireImplicit();
    this.pruneRecent();
    return {
      ok: true,
      activeTask: this.serialize(this.get(this.activeTaskId)),
      pinnedPage: this.serialize(this.get(this.pinnedContextId)),
      contexts: [...this.contexts.values()].map((item) => this.serialize(item)),
      recentPages: [...this.recentPages.values()]
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        .map((item) => this.serializeRecent(item)),
      implicitIdleMs: this.implicitIdleMs,
      recentPageTtlMs: this.recentPageTtlMs,
    };
  }
}

export { normalizeIdentity, tokenize, wantsCurrentPage, scoreCandidate };
