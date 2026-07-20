(() => {
  'use strict';

  if (globalThis.__CLAUDE_SIDEBAR_BROWSER_TASK_RUNTIME_V0138__) return;
  globalThis.__CLAUDE_SIDEBAR_BROWSER_TASK_RUNTIME_V0138__ = true;

  const MESSAGE = 'claude_sidebar_interaction';
  // Keep the old keys so the user's saved project pages survive this upgrade.
  const SESSION_KEY = 'claudeSidebarTaskStateV612';
  const LOCAL_KEY = 'claudeSidebarPagePreferencesV612';
  const state = {
    task: null,
    mode: 'follow',
    pinnedPage: null,
    nextPage: null,
    workspace: [],
    toolRequests: new Map(),
    cancelRejectors: new Map(),
    ready: false,
  };

  function makeId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function pageIdentity(tab) {
    if (!tab?.id) return null;
    let origin = null;
    let pageKey = null;
    try {
      const parsed = new URL(tab.url || '');
      origin = parsed.origin;
      pageKey = `${parsed.origin}${parsed.pathname}`;
    } catch {}
    return {
      ok: true,
      tabId: tab.id,
      windowId: tab.windowId || null,
      title: tab.title || 'Untitled',
      url: tab.url || '',
      origin,
      pageKey,
      status: tab.status || null,
      active: tab.active === true,
    };
  }

  function storageGet(area, key) {
    return new Promise((resolve) => {
      try { area.get(key, (value) => { void chrome.runtime.lastError; resolve(value?.[key]); }); }
      catch { resolve(undefined); }
    });
  }

  function storageSet(area, key, value) {
    return new Promise((resolve) => {
      try { area.set({ [key]: value }, () => { void chrome.runtime.lastError; resolve(); }); }
      catch { resolve(); }
    });
  }

  async function persist() {
    const session = chrome.storage?.session || chrome.storage?.local;
    if (session) await storageSet(session, SESSION_KEY, { task: state.task, nextPage: state.nextPage });
    if (chrome.storage?.local) {
      await storageSet(chrome.storage.local, LOCAL_KEY, {
        mode: state.mode,
        pinnedPage: state.pinnedPage,
        workspace: state.workspace,
      });
    }
  }

  async function restore() {
    const session = chrome.storage?.session || chrome.storage?.local;
    const sessionState = session ? await storageGet(session, SESSION_KEY) : null;
    const localState = chrome.storage?.local ? await storageGet(chrome.storage.local, LOCAL_KEY) : null;
    state.task = sessionState?.task || null;
    state.nextPage = sessionState?.nextPage || null;
    state.mode = localState?.mode === 'pinned' ? 'pinned' : 'follow';
    state.pinnedPage = localState?.pinnedPage || null;
    state.workspace = Array.isArray(localState?.workspace) ? localState.workspace : [];
    if (state.task?.status === 'running') state.task.status = 'recovering';
    state.ready = true;
    await validateStoredPages();
  }

  async function getTab(tabId) {
    try { return await chrome.tabs.get(Number(tabId)); } catch { return null; }
  }

  async function activeTab() {
    let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs.length) tabs = await chrome.tabs.query({ active: true });
    return tabs[0] || null;
  }

  async function capture(tabId) {
    const tab = tabId ? await getTab(tabId) : await activeTab();
    return pageIdentity(tab) || { ok: false, code: tabId ? 'target_page_closed' : 'active_tab_not_found', tabId: Number(tabId || 0) || null };
  }

  function publicState() {
    return {
      ok: true,
      task: state.task,
      mode: state.mode,
      pinnedPage: state.pinnedPage,
      nextPage: state.nextPage,
      workspace: state.workspace,
      projectPages: state.workspace,
    };
  }

  function broadcast(action, extra = {}) {
    try { chrome.runtime.sendMessage({ type: MESSAGE, action, ...extra }); } catch {}
  }

  async function broadcastState() {
    const currentPage = await capture();
    broadcast('task_state', { ...publicState(), currentPage: currentPage?.ok ? currentPage : null });
  }

  async function validatePage(page) {
    if (!page?.tabId) return null;
    const current = await capture(page.tabId);
    return current.ok ? { ...page, ...current } : null;
  }

  async function validateStoredPages() {
    const storedPinnedPage = state.pinnedPage;
    const validatedPinnedPage = await validatePage(storedPinnedPage);
    if (validatedPinnedPage) {
      state.pinnedPage = { ...storedPinnedPage, ...validatedPinnedPage, unavailable: false };
    } else if (state.mode === 'pinned' && storedPinnedPage) {
      // Preserve the user's explicit choice instead of silently falling back to the active tab.
      state.pinnedPage = { ...storedPinnedPage, unavailable: true };
    } else {
      state.pinnedPage = null;
    }
    state.nextPage = await validatePage(state.nextPage);
    const valid = [];
    for (const item of state.workspace) {
      const current = await validatePage(item);
      if (current) valid.push(current);
    }
    state.workspace = valid;
    if (state.task?.page) {
      const current = await validatePage(state.task.page);
      if (!current) state.task = null;
      else state.task.page = current;
    }
    await persist();
  }

  function normalized(value) {
    return String(value || '')
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase();
  }

  async function resolvePageReference(input = {}, options = {}) {
    if (input.tabId) {
      const page = await capture(input.tabId);
      return page.ok ? page : page;
    }
    const ref = normalized(input.pageAlias || input.alias || input.id || input.query || input.title);
    if (ref) {
      const exact = state.workspace.find((item) =>
        normalized(item.id) === ref || normalized(item.alias) === ref || normalized(item.title) === ref || normalized(item.url) === ref
      );
      if (exact) return (await validatePage(exact)) || { ok: false, code: 'target_page_closed', pageAlias: ref };
      const partial = state.workspace.find((item) =>
        normalized(item.alias).includes(ref) || normalized(item.title).includes(ref) || normalized(item.url).includes(ref)
      );
      if (partial) return (await validatePage(partial)) || { ok: false, code: 'target_page_closed', pageAlias: ref };
      if (options.includeOpenTabs !== false) {
        const tabs = (await chrome.tabs.query({})).map(pageIdentity).filter(Boolean);
        const tab = tabs.find((item) =>
          normalized(item.title) === ref || normalized(item.url) === ref ||
          normalized(item.title).includes(ref) || normalized(item.url).includes(ref)
        );
        if (tab) return tab;
      }
      return { ok: false, code: 'page_not_found', query: input.pageAlias || input.alias || input.id || input.query || input.title };
    }
    return capture();
  }

  async function taskStart(input = {}) {
    let page = null;
    let selectionSource = null;
    if (input.pageAlias || input.tabId || input.query || input.id) {
      page = await resolvePageReference(input);
      selectionSource = 'explicit_message_target';
    }
    if (!page && state.nextPage) {
      page = await validatePage(state.nextPage);
      selectionSource = 'next_message_page';
    }
    if (!page && state.mode === 'pinned') {
      if (!state.pinnedPage) return { ok: false, code: 'pinned_page_missing', mode: state.mode };
      page = await validatePage(state.pinnedPage);
      if (!page) {
        return {
          ok: false,
          code: 'pinned_page_unavailable',
          mode: state.mode,
          pinnedPage: state.pinnedPage,
          message: 'The page selected for all future messages is no longer available. Choose another page or switch back to current-page mode.',
        };
      }
      selectionSource = 'pinned_page';
    }
    if (!page) {
      page = await capture();
      selectionSource = 'current_page_at_send';
    }
    if (!page?.ok) return page;
    state.nextPage = null;
    const task = {
      id: input.taskId || makeId('task'),
      sessionId: input.sessionId || null,
      promptPreview: input.promptPreview || '',
      status: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      navigationPolicy: input.allowNavigation === true ? 'same_origin' : 'same_page',
      primaryPage: { ...page },
      page: { ...page },
      childTabIds: [],
      selectionSource,
      pageSelectionMode: state.mode,
    };
    state.task = task;
    await persist();
    await broadcastState();
    return { ok: true, action: 'task_started', task, mode: state.mode, selectionSource, pinnedPage: state.pinnedPage, nextPage: state.nextPage, workspace: state.workspace, projectPages: state.workspace };
  }

  async function taskEnd(input = {}) {
    if (input.taskId && state.task?.id && input.taskId !== state.task.id) {
      return { ok: false, code: 'task_id_mismatch', activeTaskId: state.task.id };
    }
    const ended = state.task ? { ...state.task, status: input.status || 'completed', endedAt: new Date().toISOString() } : null;
    state.task = null;
    state.toolRequests.clear();
    await persist();
    await broadcastState();
    return { ok: true, action: 'task_ended', task: ended };
  }

  async function taskCancel(input = {}) {
    if (!state.task) return { ok: true, action: 'no_active_task' };
    if (input.taskId && input.taskId !== state.task.id) return { ok: false, code: 'task_id_mismatch' };
    state.task.status = 'cancelled';
    for (const reject of state.cancelRejectors.values()) {
      try { reject(Object.assign(new Error('Browser task cancelled by user'), { code: 'task_cancelled' })); } catch {}
    }
    state.cancelRejectors.clear();
    state.task.cancelledAt = new Date().toISOString();
    state.task.updatedAt = new Date().toISOString();
    // The user's STOP must reach the executors: cancel every inflight tool
    // request so page scrolling actually halts (previously stop only killed
    // host processes and the extension kept seeking as a zombie).
    for (const [, rejectCancel] of state.cancelRejectors) {
      try { rejectCancel(Object.assign(new Error('Browser task cancelled by user'), { code: 'task_cancelled' })); } catch {}
    }
    state.cancelRejectors.clear();
    try {
      const background = globalThis.__claudeSidebarAbortAllInflight;
      if (typeof background === 'function') background('user_stop');
    } catch {}
    await persist();
    broadcast('progress', { task: state.task, label: '任务已停止', phase: 'error' });
    return { ok: true, action: 'task_cancelled', task: state.task };
  }

  async function pinCurrent(input = {}) {
    const page = await resolvePageReference(input);
    if (!page?.ok) return page;
    state.mode = 'pinned';
    state.pinnedPage = { ...page, id: page.id || state.pinnedPage?.id || makeId('page'), alias: input.alias || input.pageAlias || page.alias || state.pinnedPage?.alias || null, unavailable: false, pinnedAt: new Date().toISOString() };
    state.nextPage = null;
    await persist();
    await broadcastState();
    return publicState();
  }

  async function followCurrent() {
    state.mode = 'follow';
    state.pinnedPage = null;
    state.nextPage = null;
    await persist();
    await broadcastState();
    return publicState();
  }

  async function usePage(input = {}) {
    const page = await resolvePageReference(input);
    if (!page?.ok) return page;
    const selected = { ...page };
    if (state.task) {
      state.task.page = selected;
      state.task.status = 'running';
      state.task.updatedAt = new Date().toISOString();
      state.nextPage = null;
    } else {
      state.nextPage = selected;
    }
    await persist();
    await broadcastState();
    return { ...publicState(), action: state.task ? 'task_page_selected' : 'next_message_page_selected', selectedPage: selected };
  }

  async function workspaceAddCurrent(input = {}) {
    const page = await resolvePageReference({ tabId: input.tabId });
    if (!page?.ok) return page;
    const existing = state.workspace.find((item) => item.tabId === page.tabId);
    if (existing) {
      Object.assign(existing, page, { alias: input.alias || existing.alias || page.title });
    } else {
      state.workspace.push({ ...page, id: makeId('project'), alias: input.alias || page.title || null });
    }
    await persist();
    await broadcastState();
    return publicState();
  }

  async function workspaceActivate(input = {}) {
    // Compatibility alias. Selecting a project page no longer silently pins the whole conversation.
    return usePage(input);
  }

  async function workspaceRemove(input = {}) {
    state.workspace = state.workspace.filter((item) => item.id !== input.id && item.alias !== input.alias);
    if (state.nextPage && (state.nextPage.id === input.id || state.nextPage.alias === input.alias)) state.nextPage = null;
    await persist();
    await broadcastState();
    return publicState();
  }

  async function explicitToolPage(input = {}) {
    if (!input.tabId && !input.pageAlias && !input.pageId && !input.pageQuery) return null;
    return resolvePageReference({
      tabId: input.tabId,
      pageAlias: input.pageAlias,
      id: input.pageId,
      query: input.pageQuery,
    });
  }

  async function pageForTool(input = {}) {
    // Explicit page selection always wins, even while a task is bound to another page.
    // This is what enables one turn to read a Lark PRD and then inspect an admin page.
    const explicit = await explicitToolPage(input);
    if (explicit) {
      if (!explicit.ok) return explicit;
      return { ok: true, source: input.pageAlias || input.pageId || input.pageQuery ? 'project_page' : 'explicit_tab', task: state.task, identity: explicit };
    }
    if (state.task) {
      if (state.task.status === 'cancelled') return { ok: false, code: 'task_cancelled', task: state.task };
      if (state.task.status === 'paused') return { ok: false, code: 'task_paused_page_changed', task: state.task };
      const current = await capture(state.task.page?.tabId);
      if (!current.ok) return { ...current, task: state.task };
      const old = state.task.page || {};
      if (state.task.navigationPolicy === 'same_page' && old.pageKey && current.pageKey !== old.pageKey) {
        state.task.status = 'paused';
        await persist();
        broadcast('page_changed', { task: state.task, reason: '页面地址发生变化' });
        return { ok: false, code: 'target_page_changed', task: state.task, current };
      }
      if (state.task.navigationPolicy === 'same_origin' && old.origin && current.origin !== old.origin) {
        state.task.status = 'paused';
        await persist();
        broadcast('page_changed', { task: state.task, reason: '页面站点发生变化' });
        return { ok: false, code: 'target_origin_changed', task: state.task, current };
      }
      state.task.page = { ...old, ...current };
      state.task.updatedAt = new Date().toISOString();
      return { ok: true, source: 'ui_task', task: state.task, identity: state.task.page };
    }
    if (state.nextPage) {
      const current = await validatePage(state.nextPage);
      if (current) return { ok: true, source: 'next_message_page', identity: current };
    }
    if (state.mode === 'pinned' && state.pinnedPage) {
      const current = await validatePage(state.pinnedPage);
      return current ? { ok: true, source: 'pinned_page', identity: current } : { ok: false, code: 'target_page_closed' };
    }
    return { ok: false, code: 'ui_task_missing' };
  }

  async function listPages() {
    const tabs = (await chrome.tabs.query({})).map(pageIdentity).filter(Boolean);
    return { ok: true, tabs, workspace: state.workspace, projectPages: state.workspace, task: state.task, nextPage: state.nextPage };
  }

  async function handleAction(action, input = {}) {
    await ready;
    switch (action) {
      case 'task_start': return taskStart(input);
      case 'task_end': return taskEnd(input);
      case 'task_cancel': return taskCancel(input);
      case 'pin_current':
      case 'always_use_page': return pinCurrent(input);
      case 'follow_current':
      case 'use_current_each_message': return followCurrent();
      case 'use_page':
      case 'select_page': return usePage(input);
      case 'workspace_add_current':
      case 'project_page_add': return workspaceAddCurrent(input);
      case 'workspace_activate': return workspaceActivate(input);
      case 'workspace_remove':
      case 'project_page_remove': return workspaceRemove(input);
      case 'workspace_list':
      case 'project_pages': return publicState();
      case 'task_for_tool': return pageForTool(input);
      case 'status': {
        const currentPage = await capture();
        return { ...publicState(), currentPage: currentPage?.ok ? currentPage : null };
      }
      case 'capture': return capture(input.tabId);
      case 'list':
      case 'list_pages': return listPages();
      default: return { ok: false, code: 'unknown_interaction_action', action };
    }
  }

  async function runCancellable(id, executor) {
    if (typeof executor !== 'function') throw new TypeError('executor must be a function');
    if (!state.task) return executor();
    if (state.task.status === 'cancelled') {
      throw Object.assign(new Error('Browser task cancelled by user'), { code: 'task_cancelled' });
    }
    const key = String(id);
    let rejectCancel;
    const cancellation = new Promise((_resolve, reject) => { rejectCancel = reject; });
    state.cancelRejectors.set(key, rejectCancel);
    try {
      return await Promise.race([Promise.resolve().then(executor), cancellation]);
    } finally {
      state.cancelRejectors.delete(key);
    }
  }

  function toolStarted(id, tool, args) {
    if (!state.task) return;
    state.toolRequests.set(String(id), { tool, startedAt: Date.now() });
    const targetPage = args?.tabId
      ? state.workspace.find((page) => Number(page.tabId) === Number(args.tabId))
        || (Number(state.task?.page?.tabId) === Number(args.tabId) ? state.task.page : null)
      : null;
    broadcast('progress', {
      task: state.task, tool, label: toolLabel(tool, args), phase: 'running',
      detail: targetPage?.title || targetPage?.alias || '',
    });
  }

  // Fine-grained execution progress ("正在读取第 12/25 节") surfaced to the
  // sidepanel through the same channel the tool banners already use.
  function progressDetail(label) {
    if (!state.task || !label) return;
    broadcast('progress', { task: state.task, label: String(label).slice(0, 120), phase: 'running' });
  }

  function toolCompleted(id, ok, detail = '') {
    const entry = state.toolRequests.get(String(id));
    if (!entry) return;
    state.toolRequests.delete(String(id));
    broadcast('progress', {
      task: state.task,
      tool: entry.tool,
      label: toolLabel(entry.tool),
      phase: ok ? 'done' : 'error',
      detail: detail ? String(detail).slice(0, 100) : '',
    });
  }

  function toolLabel(tool) {
    const labels = {
      browser_app_inspect: '识别页面结构', browser_app_query: '查询页面数据',
      lark_deep_read: '读取文档内容', lark_locate: '定位文档位置',
      get_page_text: '读取页面文字', read_page: '读取页面结构', find: '查找页面元素',
      javascript_tool: '分析页面数据', navigate: '打开目标页面', computer: '操作目标页面',
    };
    return labels[tool] || `执行 ${tool || '浏览器工具'}`;
  }

  async function handlePageContextAction(args = {}) {
    const actionMap = {
      start_task: 'task_start', end_task: 'task_end', cancel_task: 'task_cancel',
      pin_current: 'pin_current', always_use_page: 'always_use_page',
      follow_current: 'follow_current', use_current_each_message: 'use_current_each_message',
      use_page: 'use_page', select_page: 'select_page', status: 'status',
      list_pages: 'list_pages', list: 'list_pages', capture: 'capture', task_for_tool: 'task_for_tool',
      workspace_add: 'workspace_add_current', workspace_remove: 'workspace_remove',
      workspace_activate: 'workspace_activate', workspace_list: 'workspace_list',
      project_page_add: 'project_page_add', project_page_remove: 'project_page_remove', project_pages: 'project_pages',
    };
    return handleAction(actionMap[String(args.action || 'capture')] || String(args.action || 'capture'), args);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== MESSAGE) return undefined;
    handleAction(String(message.action || 'status'), message).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, code: 'interaction_handler_failed', error: String(error?.message || error) });
    });
    return true;
  });

  chrome.tabs.onActivated.addListener(async () => {
    if (!state.task && state.mode === 'follow' && !state.nextPage) await broadcastState();
  });

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    if (state.task?.page?.tabId === tabId) {
      state.task.status = 'paused';
      state.task.pauseReason = 'target_page_closed';
      await persist();
      broadcast('page_changed', { task: state.task, reason: '目标页面已关闭' });
    }
    state.workspace = state.workspace.filter((item) => item.tabId !== tabId);
    if (state.nextPage?.tabId === tabId) state.nextPage = null;
    if (state.pinnedPage?.tabId === tabId) {
      // Keep the explicit pinned preference visible and fail closed on the next send.
      state.pinnedPage = { ...state.pinnedPage, unavailable: true, closedAt: new Date().toISOString() };
    }
    await persist();
  });

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (state.pinnedPage?.tabId === tabId) {
      const currentPinned = pageIdentity(tab);
      if (currentPinned) state.pinnedPage = { ...state.pinnedPage, ...currentPinned, unavailable: false };
      await persist();
      await broadcastState();
    }
    if (!state.task || state.task.page?.tabId !== tabId || !changeInfo.url) return;
    const current = pageIdentity(tab);
    const old = state.task.page;
    const safe = state.task.navigationPolicy === 'same_origin'
      ? (!old.origin || old.origin === current.origin)
      : (!old.pageKey || old.pageKey === current.pageKey);
    if (safe) {
      state.task.page = { ...old, ...current };
      await persist();
      await broadcastState();
      return;
    }
    state.task.status = 'paused';
    state.task.pauseReason = 'target_page_changed';
    await persist();
    broadcast('page_changed', { task: state.task, reason: '目标页面发生导航' });
  });

  const ready = restore().catch(() => { state.ready = true; });
  globalThis.__claudeSidebarBrowserTaskRuntime = {
    ready, state, handleAction, handlePageContextAction, toolStarted, toolCompleted, runCancellable, publicState, progressDetail,
  };
})();
