import crypto from 'node:crypto';

function normalizeIdentity(input = {}) {
  const tabId = Number(input.tabId || 0);
  let origin = null;
  let pageKey = null;
  try {
    const parsed = new URL(String(input.url || ''));
    origin = parsed.origin;
    pageKey = `${parsed.origin}${parsed.pathname}`;
  } catch {}
  return {
    tabId,
    windowId: Number(input.windowId || 0) || null,
    title: String(input.title || 'Untitled'),
    url: String(input.url || ''),
    origin,
    pageKey,
    status: input.status || null,
  };
}

function makeId(prefix = 'task') {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

export class PageContextManager {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.implicitIdleMs = Math.max(1000, Number(options.implicitIdleMs || 20000));
    this.contexts = new Map();
    this.activeTaskId = null;
    this.pinnedContextId = null;
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
      createdAt: now,
      lastUsedAt: now,
      identity: normalized,
      status: 'active',
      childTabIds: [],
    };
    this.contexts.set(id, context);
    if (mode === 'pinned') this.pinnedContextId = id;
    else this.activeTaskId = id;
    return this.serialize(context);
  }

  serialize(context) {
    if (!context) return null;
    return {
      id: context.id,
      alias: context.alias,
      mode: context.mode,
      implicit: context.implicit,
      navigationPolicy: context.navigationPolicy,
      createdAt: new Date(context.createdAt).toISOString(),
      lastUsedAt: new Date(context.lastUsedAt).toISOString(),
      status: context.status,
      ...context.identity,
      childTabIds: [...(context.childTabIds || [])],
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
    if (context) context.lastUsedAt = this.now();
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

  async start(captureFn, options = {}) {
    const identity = options.tabId
      ? await captureFn({ tabId: Number(options.tabId) })
      : await captureFn({ active: true });
    if (!identity?.ok || !identity.tabId) return identity || { ok: false, code: 'page_capture_failed' };
    const context = this.create(identity, {
      mode: options.mode || 'task',
      alias: options.alias,
      implicit: options.implicit === true,
      navigationPolicy: options.navigationPolicy || 'same_page',
    });
    return { ok: true, action: context.mode === 'pinned' ? 'page_pinned' : 'task_started', context };
  }

  async resolve(captureFn, options = {}) {
    if (options.tabId) {
      const identity = await captureFn({ tabId: Number(options.tabId) });
      return identity?.ok ? { ok: true, source: 'explicit_tab', identity } : identity;
    }

    this.expireImplicit();
    let context = options.taskId ? this.get(options.taskId) : this.current();
    if (!context && options.autoStart !== false) {
      const started = await this.start(captureFn, {
        mode: 'task',
        implicit: true,
        navigationPolicy: options.navigationPolicy || 'same_page',
      });
      if (!started?.ok) return started;
      context = this.get(started.context.id);
    }
    if (!context) return { ok: false, code: 'page_context_missing' };

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

  status() {
    this.expireImplicit();
    return {
      ok: true,
      activeTask: this.serialize(this.get(this.activeTaskId)),
      pinnedPage: this.serialize(this.get(this.pinnedContextId)),
      contexts: [...this.contexts.values()].map((item) => this.serialize(item)),
      implicitIdleMs: this.implicitIdleMs,
    };
  }
}

export { normalizeIdentity };
