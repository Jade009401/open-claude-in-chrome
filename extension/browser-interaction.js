(() => {
  'use strict';

  if (globalThis.__CLAUDE_SIDEBAR_BROWSER_INTERACTION_V0138__) return;
  globalThis.__CLAUDE_SIDEBAR_BROWSER_INTERACTION_V0138__ = true;

  const MESSAGE = 'claude_sidebar_interaction';
  const COMPLETION_TYPES = new Set([
    'done', 'complete', 'completed', 'result', 'final', 'chat_complete',
    'response_complete', 'session_complete', 'error', 'failed', 'cancelled', 'canceled', 'assistant_done'
  ]);
  const state = {
    task: null,
    mode: 'follow',
    pinnedPage: null,
    nextPage: null,
    currentBrowserPage: null,
    projectPages: [],
    progress: [],
    ports: new Set(),
    mounted: false,
    bar: null,
    pageSummary: null,
    changeButton: null,
    progressNode: null,
    stopButton: null,
    popover: null,
  };

  function runtimeRequest(action, payload = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: MESSAGE, action, ...payload }, (response) => {
          void chrome.runtime.lastError;
          resolve(response || { ok: false, code: 'no_response' });
        });
      } catch (error) {
        resolve({ ok: false, code: 'runtime_message_failed', error: String(error?.message || error) });
      }
    });
  }

  function hostName(url) {
    try { return new URL(url).hostname; } catch { return ''; }
  }

  function cleanVisibleText(value) {
    return String(value || '')
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function shortTitle(page, max = 34) {
    const title = cleanVisibleText(page?.alias || page?.title || '');
    if (title) return title.length > max ? `${title.slice(0, max - 1)}…` : title;
    return hostName(page?.url) || '当前页面';
  }

  function iconForPage(page) {
    const url = String(page?.url || '');
    if (/larksuite|feishu/i.test(url)) return '📄';
    if (/k8s|kubernetes/i.test(url)) return '☸';
    if (/github/i.test(url)) return '◉';
    if (/jenkins/i.test(url)) return '⚙';
    if (/grafana/i.test(url)) return '▦';
    return '▣';
  }

  function setProgress(label, phase = 'running', detail = '') {
    const item = { label: String(label || '正在处理'), phase, detail: String(detail || ''), at: Date.now() };
    const existing = state.progress.findIndex((entry) => entry.label === item.label);
    if (existing >= 0) state.progress[existing] = item;
    else state.progress.push(item);
    if (state.progress.length > 5) state.progress.splice(0, state.progress.length - 5);
    render();
  }

  function clearProgress() {
    state.progress = [];
    render();
  }

  function pageForNextMessage() {
    if (state.nextPage) return state.nextPage;
    if (state.mode === 'pinned' && state.pinnedPage) return state.pinnedPage;
    return state.currentBrowserPage;
  }

  function authoritySnapshot() {
    return {
      type: 'context_sync',
      version: '0.15.3',
      authority: 'extension_page_selection',
      selection: {
        mode: state.mode,
        pinnedPage: state.pinnedPage ? { ...state.pinnedPage } : null,
        nextPage: state.nextPage ? { ...state.nextPage } : null,
        currentPage: state.currentBrowserPage ? { ...state.currentBrowserPage } : null,
        projectPages: state.projectPages.map((page) => ({ ...page })),
        task: state.task ? { ...state.task, page: state.task.page ? { ...state.task.page } : null } : null,
        syncedAt: new Date().toISOString(),
      },
    };
  }

  function syncSelectionToPort(port) {
    if (!port || typeof port.postMessage !== 'function') return false;
    try {
      port.postMessage(authoritySnapshot());
      return true;
    } catch {
      return false;
    }
  }

  function syncSelectionToHost() {
    for (const port of state.ports) syncSelectionToPort(port);
  }

  function summaryText() {
    if (state.task?.page) return `正在读取：${shortTitle(state.task.page)}`;
    const page = pageForNextMessage();
    if (state.nextPage) return `下一条消息将读取：${shortTitle(page)}`;
    if (state.mode === 'pinned') return `之后的消息始终读取：${shortTitle(page)}`;
    return `本条消息将读取：${shortTitle(page)}`;
  }

  function render() {
    if (!state.bar) return;
    const running = ['running', 'paused', 'cancelling', 'recovering'].includes(state.task?.status);
    state.bar.dataset.running = running ? 'true' : 'false';
    state.bar.dataset.paused = state.task?.status === 'paused' ? 'true' : 'false';

    // Page-binding banner removed: the panel auto-binds to the current tab on
    // send (see beginMessage), and the "本条消息将读取… / 更改 / 锁定" affordances
    // were unused, inconvenient, and misleading for the common single-page case.
    // The bar now surfaces only what's actionable during a running task —
    // the stop control and live progress — and stays hidden when idle.
    if (state.pageSummary) state.pageSummary.hidden = true;
    if (state.changeButton) state.changeButton.hidden = true;
    if (state.stopButton) state.stopButton.hidden = !running;

    let progressText = '';
    if (state.task?.status === 'paused') {
      progressText = '页面发生变化，任务已暂停';
    } else if (running) {
      const latest = state.progress[state.progress.length - 1];
      if (latest) {
        const prefix = latest.phase === 'done' ? '✓' : latest.phase === 'error' ? '!' : '→';
        progressText = `${prefix} ${latest.label}${latest.detail ? ` · ${latest.detail}` : ''}`;
      } else {
        progressText = '→ 正在处理当前任务';
      }
    }
    if (state.progressNode) {
      state.progressNode.textContent = progressText;
      state.progressNode.hidden = !progressText;
    }
    // Mirror live page-task progress into the inline working indicator at the
    // answer position, so all "what Claude is doing" cues surface in one place.
    if (progressText && running) {
      try { globalThis.__claudeSidebarActivity?.(progressText); } catch {}
    }

    // Hide the whole bar when idle — nothing actionable to show.
    state.bar.hidden = !running;
    renderPageChooser();
  }

  async function refreshStatus() {
    const response = await runtimeRequest('status');
    if (!response?.ok) return response;
    state.task = response.task || null;
    state.mode = response.mode || 'follow';
    state.pinnedPage = response.pinnedPage || null;
    state.nextPage = response.nextPage || null;
    state.currentBrowserPage = response.currentPage || null;
    state.projectPages = Array.isArray(response.projectPages || response.workspace) ? (response.projectPages || response.workspace) : [];
    render();
    syncSelectionToHost();
    return response;
  }

  async function beginMessage(meta = {}) {
    const response = await runtimeRequest('task_start', {
      taskId: meta.taskId || `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: meta.sessionId || null,
      promptPreview: String(meta.prompt || '').slice(0, 160),
    });
    if (response?.ok) {
      state.task = response.task;
      state.nextPage = response.nextPage || null;
      state.projectPages = response.projectPages || response.workspace || state.projectPages;
      clearProgress();
      const bindingLabel = response.selectionSource === 'pinned_page' ? '已使用固定页面' : response.selectionSource === 'next_message_page' ? '已使用指定页面' : '已锁定当前页面';
      setProgress(bindingLabel, 'done', shortTitle(response.task?.page));
      setProgress('正在分析请求', 'running');
    } else {
      setProgress('页面绑定失败', 'error', response?.code || 'unknown');
    }
    return response;
  }

  async function endMessage(status = 'completed', detail = null) {
    const response = await runtimeRequest('task_end', { taskId: state.task?.id, status, detail });
    if (status === 'completed') setProgress('任务完成', 'done');
    else if (status === 'cancelled') setProgress('任务已停止', 'error');
    else setProgress('任务结束', status === 'failed' ? 'error' : 'done', detail || '');
    state.task = null;
    setTimeout(clearProgress, 1800);
    render();
    return response;
  }

  async function cancelTask() {
    if (!state.task) return;
    const taskId = state.task.id;
    state.task.status = 'cancelling';
    setProgress('正在停止任务', 'running');
    await runtimeRequest('task_cancel', { taskId });
    for (const port of state.ports) {
      try { port.postMessage({ type: 'interrupt', taskId, reason: 'user_cancelled' }); } catch {}
    }
    await endMessage('cancelled');
  }

  async function chooseCurrentEachMessage() {
    const response = await runtimeRequest('use_current_each_message');
    if (response?.ok) applyResponse(response);
  }

  async function alwaysUseCurrentPage() {
    const response = await runtimeRequest('always_use_page');
    if (response?.ok) applyResponse(response);
  }

  async function useProjectPageOnce(page) {
    const response = await runtimeRequest('use_page', { id: page.id, pageAlias: page.alias });
    if (response?.ok) {
      applyResponse(response);
      closePopover();
    }
  }

  async function alwaysUseProjectPage(page) {
    const response = await runtimeRequest('always_use_page', { id: page.id, pageAlias: page.alias });
    if (response?.ok) {
      applyResponse(response);
      closePopover();
    }
  }

  async function addCurrentToProjectPages() {
    const aliasValue = window.prompt('给这个页面起一个容易识别的名字', '') ?? null;
    if (aliasValue === null) return;
    const response = await runtimeRequest('project_page_add', { alias: aliasValue.trim() || undefined });
    if (response?.ok) applyResponse(response);
  }

  async function removeProjectPage(page) {
    const response = await runtimeRequest('project_page_remove', { id: page.id, alias: page.alias });
    if (response?.ok) applyResponse(response);
  }

  function applyResponse(response) {
    state.task = response.task ?? state.task;
    state.mode = response.mode || state.mode;
    state.pinnedPage = response.pinnedPage ?? state.pinnedPage;
    state.nextPage = response.nextPage ?? null;
    state.projectPages = response.projectPages || response.workspace || state.projectPages;
    render();
    syncSelectionToHost();
  }

  function closePopover() {
    if (state.popover) state.popover.hidden = true;
  }

  function choiceButton({ title, description, selected, onClick }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'claude-sidebar-page-choice';
    button.dataset.selected = selected ? 'true' : 'false';
    const mark = document.createElement('span');
    mark.className = 'claude-sidebar-page-choice-mark';
    mark.textContent = selected ? '✓' : '';
    const copy = document.createElement('span');
    copy.className = 'claude-sidebar-page-choice-copy';
    const titleNode = document.createElement('strong');
    titleNode.textContent = title;
    const descriptionNode = document.createElement('small');
    descriptionNode.textContent = description;
    copy.append(titleNode, descriptionNode);
    button.append(mark, copy);
    button.addEventListener('click', onClick);
    return button;
  }

  function renderPageChooser() {
    if (!state.popover || state.popover.hidden) return;
    state.popover.replaceChildren();

    const header = document.createElement('div');
    header.className = 'claude-sidebar-page-chooser-header';
    const headerTitle = document.createElement('strong');
    headerTitle.textContent = '消息使用哪个页面';
    const headerHint = document.createElement('span');
    headerHint.textContent = '执行开始后会锁定页面，你仍可自由切换浏览器标签。';
    header.append(headerTitle, headerHint);
    state.popover.appendChild(header);

    state.popover.appendChild(choiceButton({
      title: '每条消息使用发送时的当前页面',
      description: '切换浏览器标签后，下一条消息自动使用新页面。',
      selected: state.mode === 'follow' && !state.nextPage,
      onClick: async () => { await chooseCurrentEachMessage(); closePopover(); },
    }));

    state.popover.appendChild(choiceButton({
      title: `始终使用当前页面：${shortTitle(state.currentBrowserPage, 24)}`,
      description: '以后即使切换标签，也继续使用这个页面。',
      selected: state.mode === 'pinned' && state.pinnedPage?.tabId === state.currentBrowserPage?.tabId,
      onClick: async () => { await alwaysUseCurrentPage(); closePopover(); },
    }));

    const section = document.createElement('div');
    section.className = 'claude-sidebar-project-pages-title';
    section.innerHTML = '<strong>项目页面</strong><span>保存相关页面，Claude 可在同一任务中跨页读取。</span>';
    state.popover.appendChild(section);

    if (!state.projectPages.length) {
      const empty = document.createElement('div');
      empty.className = 'claude-sidebar-project-pages-empty';
      empty.textContent = '还没有保存项目页面。';
      state.popover.appendChild(empty);
    }

    for (const page of state.projectPages) {
      const row = document.createElement('div');
      row.className = 'claude-sidebar-project-page-row';
      const pageCopy = document.createElement('div');
      pageCopy.className = 'claude-sidebar-project-page-copy';
      const name = document.createElement('strong');
      name.textContent = `${iconForPage(page)} ${page.alias || shortTitle(page)}`;
      const host = document.createElement('small');
      host.textContent = hostName(page.url) || page.url || '';
      pageCopy.append(name, host);

      const once = document.createElement('button');
      once.type = 'button';
      once.textContent = state.task ? '当前任务使用' : '下一条使用';
      once.title = '只改变当前任务或下一条消息，不改变默认设置';
      once.addEventListener('click', () => useProjectPageOnce(page));

      const always = document.createElement('button');
      always.type = 'button';
      always.textContent = '始终';
      always.title = '以后每条消息默认使用此页面';
      always.addEventListener('click', () => alwaysUseProjectPage(page));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'claude-sidebar-project-page-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', '移除项目页面');
      remove.addEventListener('click', () => removeProjectPage(page));
      row.append(pageCopy, once, always, remove);
      state.popover.appendChild(row);
    }

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'claude-sidebar-project-page-add';
    add.textContent = '+ 保存当前页面到项目页面';
    add.addEventListener('click', addCurrentToProjectPages);
    state.popover.appendChild(add);
  }

  function togglePopover() {
    if (!state.popover) return;
    state.popover.hidden = !state.popover.hidden;
    renderPageChooser();
  }

  function findComposer() {
    const input = document.querySelector('#prompt-input, #promptInput, #prompt, #message-input, #messageInput, textarea, [contenteditable="true"][role="textbox"]');
    if (!input) return null;
    return input.closest('form, .composer, .input-area, .prompt-area, .chat-input, [data-composer]') || input.parentElement;
  }

  function installStyles() {
    if (document.getElementById('claude-sidebar-interaction-styles')) return;
    const style = document.createElement('style');
    style.id = 'claude-sidebar-interaction-styles';
    style.textContent = `
      #claude-sidebar-page-context-bar{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:6px;margin:0 0 7px;padding:7px 8px;border:1px solid rgba(127,127,127,.20);border-radius:11px;background:rgba(127,127,127,.055);font:12px/1.3 system-ui,sans-serif;box-sizing:border-box;max-width:100%;}
      #claude-sidebar-page-context-bar[data-running="true"]{border-color:rgba(74,116,220,.44);background:rgba(74,116,220,.07);}
      #claude-sidebar-page-context-bar[data-paused="true"]{border-color:rgba(220,150,50,.55);background:rgba(220,150,50,.08);}
      .claude-sidebar-page-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650;padding:3px 4px;}
      .claude-sidebar-change-button,.claude-sidebar-stop-button{border:0;border-radius:8px;color:inherit;cursor:pointer;font:inherit;min-height:28px;padding:4px 8px;}
      .claude-sidebar-change-button{background:rgba(127,127,127,.10);}
      .claude-sidebar-change-button:hover{background:rgba(127,127,127,.17);}
      .claude-sidebar-stop-button{background:rgba(205,62,62,.12);color:#c43b3b;font-weight:650;}
      .claude-sidebar-progress{grid-column:1/-1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 4px 1px;opacity:.68;font-size:11px;}
      .claude-sidebar-page-chooser{position:absolute;left:0;right:0;bottom:calc(100% + 7px);z-index:2147483644;max-height:min(440px,70vh);overflow:auto;padding:10px;border:1px solid rgba(127,127,127,.25);border-radius:13px;background:Canvas;color:CanvasText;box-shadow:0 12px 32px rgba(0,0,0,.18);}
      .claude-sidebar-page-chooser[hidden]{display:none;}
      .claude-sidebar-page-chooser-header{display:flex;flex-direction:column;gap:3px;padding:2px 4px 8px;}
      .claude-sidebar-page-chooser-header span,.claude-sidebar-project-pages-title span{font-size:11px;opacity:.62;}
      .claude-sidebar-page-choice{width:100%;display:grid;grid-template-columns:20px minmax(0,1fr);gap:5px;align-items:start;border:0;border-radius:9px;background:transparent;color:inherit;text-align:left;padding:8px 7px;cursor:pointer;}
      .claude-sidebar-page-choice:hover,.claude-sidebar-page-choice[data-selected="true"]{background:rgba(80,120,220,.10);}
      .claude-sidebar-page-choice-mark{font-weight:800;color:#4777d8;}
      .claude-sidebar-page-choice-copy{display:flex;flex-direction:column;gap:2px;min-width:0;}
      .claude-sidebar-page-choice-copy small{opacity:.64;}
      .claude-sidebar-project-pages-title{display:flex;flex-direction:column;gap:2px;margin:8px 4px 5px;padding-top:8px;border-top:1px solid rgba(127,127,127,.18);}
      .claude-sidebar-project-pages-empty{padding:8px;opacity:.6;font-size:11px;}
      .claude-sidebar-project-page-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:4px;align-items:center;padding:4px;border-radius:9px;}
      .claude-sidebar-project-page-row:hover{background:rgba(127,127,127,.07);}
      .claude-sidebar-project-page-copy{display:flex;flex-direction:column;gap:2px;min-width:0;padding:3px;}
      .claude-sidebar-project-page-copy strong,.claude-sidebar-project-page-copy small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .claude-sidebar-project-page-copy small{opacity:.55;font-size:10px;}
      .claude-sidebar-project-page-row>button{border:0;border-radius:7px;background:rgba(127,127,127,.10);color:inherit;padding:5px 6px;font:11px/1.2 system-ui,sans-serif;cursor:pointer;white-space:nowrap;}
      .claude-sidebar-project-page-row>button:hover{background:rgba(80,120,220,.16);}
      .claude-sidebar-project-page-row>.claude-sidebar-project-page-remove{background:transparent;font-size:17px;opacity:.55;padding:2px 5px;}
      .claude-sidebar-project-page-add{width:100%;border:1px dashed rgba(127,127,127,.32);border-radius:8px;background:transparent;color:inherit;padding:8px;cursor:pointer;margin-top:6px;}
    `;
    document.head.appendChild(style);
  }

  function mount() {
    if (state.mounted) return true;
    const composer = findComposer();
    if (!composer || !composer.parentElement) return false;
    installStyles();

    const bar = document.createElement('div');
    bar.id = 'claude-sidebar-page-context-bar';
    const summary = document.createElement('div');
    summary.className = 'claude-sidebar-page-summary';
    const changeButton = document.createElement('button');
    changeButton.type = 'button';
    changeButton.className = 'claude-sidebar-change-button';
    changeButton.textContent = '更改';
    changeButton.addEventListener('click', togglePopover);
    const stopButton = document.createElement('button');
    stopButton.type = 'button';
    stopButton.className = 'claude-sidebar-stop-button';
    stopButton.textContent = '停止';
    stopButton.hidden = true;
    stopButton.addEventListener('click', cancelTask);
    const progress = document.createElement('div');
    progress.className = 'claude-sidebar-progress';
    const popover = document.createElement('div');
    popover.className = 'claude-sidebar-page-chooser';
    popover.hidden = true;
    bar.append(summary, changeButton, stopButton, progress, popover);
    composer.parentElement.insertBefore(bar, composer);

    state.bar = bar;
    state.pageSummary = summary;
    state.changeButton = changeButton;
    state.stopButton = stopButton;
    state.progressNode = progress;
    state.popover = popover;
    state.mounted = true;
    refreshStatus();
    render();
    return true;
  }

  function messageType(message) {
    return String(message?.type || message?.event || message?.status || '').toLowerCase();
  }

  function observePort(port) {
    if (!port || state.ports.has(port)) return port;
    state.ports.add(port);
    queueMicrotask(() => syncSelectionToPort(port));
    try {
      port.onMessage.addListener((message) => {
        const type = messageType(message);
        if (type.includes('tool') || type.includes('stream') || type.includes('delta') || type === 'status') {
          if (state.task) state.task.status = 'running';
          setProgress(message?.label || message?.tool || '正在执行', 'running');
        }
        if (COMPLETION_TYPES.has(type) || message?.done === true || message?.final === true) {
          const failed = type.includes('error') || type.includes('fail');
          endMessage(failed ? 'failed' : 'completed', message?.error || null);
        }
      });
      port.onDisconnect.addListener(() => {
        state.ports.delete(port);
        if (state.task) setProgress('连接正在恢复', 'running');
      });
    } catch {}
    return port;
  }

  function patchNativeMessaging() {
    if (!chrome?.runtime?.connectNative || chrome.runtime.connectNative.__claudeSidebarPatchedV0138) return;
    const original = chrome.runtime.connectNative.bind(chrome.runtime);
    const patched = (...args) => observePort(original(...args));
    patched.__claudeSidebarPatchedV0138 = true;
    chrome.runtime.connectNative = patched;
  }

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== MESSAGE) return;
      if (message.action === 'progress') {
        if (message.task) state.task = message.task;
        setProgress(message.label || message.tool || '正在执行', message.phase || 'running', message.detail || '');
      } else if (message.action === 'task_state') {
        state.task = message.task || null;
        if (message.mode) state.mode = message.mode;
        if (message.pinnedPage !== undefined) state.pinnedPage = message.pinnedPage;
        if (message.nextPage !== undefined) state.nextPage = message.nextPage;
        if (message.currentPage !== undefined) state.currentBrowserPage = message.currentPage;
        if (Array.isArray(message.projectPages || message.workspace)) state.projectPages = message.projectPages || message.workspace;
        render();
        syncSelectionToHost();
      } else if (message.action === 'page_changed') {
        if (state.task) state.task.status = 'paused';
        setProgress('目标页面发生变化', 'error', message.reason || '需要重新选择页面');
      }
    });
  } catch {}

  document.addEventListener('click', (event) => {
    if (!state.popover || state.popover.hidden) return;
    if (!state.bar?.contains(event.target)) closePopover();
  }, true);

  patchNativeMessaging();
  globalThis.__claudeSidebarInteraction = { beginMessage, endMessage, cancelTask, status: refreshStatus, setProgress, syncSelection: syncSelectionToHost, authoritySnapshot };

  if (!mount()) {
    const observer = new MutationObserver(() => { if (mount()) observer.disconnect(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 30000);
  }
})();
