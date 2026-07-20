(() => {
  'use strict';
  if (globalThis.__CLAUDE_SIDEBAR_COMPAT_BRIDGE_V0138__) return;
  globalThis.__CLAUDE_SIDEBAR_COMPAT_BRIDGE_V0138__ = true;

  const CHAT_TYPES = new Set(['chat', 'send_message', 'user_message']);
  const prepared = { context: null, replaying: false, sendChain: Promise.resolve() };

  function composerInput() {
    return document.querySelector('#prompt-input, #promptInput, #prompt, #message-input, #messageInput, textarea, [contenteditable="true"][role="textbox"]');
  }
  function inputText() {
    const input = composerInput();
    return String(input?.value ?? input?.textContent ?? '').trim();
  }
  function messagePrompt(message) {
    return String(message?.prompt ?? message?.message ?? message?.text ?? inputText()).trim();
  }
  function enrichAttachments(outgoing) {
    if (!Array.isArray(outgoing.attachments) || !outgoing.attachments.length) {
      const files = globalThis.__claudeSidebarAttachments?.takeReady?.() || [];
      if (files.length) outgoing.attachments = files;
    }
    return outgoing;
  }
  async function ensureInteractionContext(outgoing) {
    if (outgoing.interactionContext?.ok !== false && outgoing.interactionContext?.task?.page?.tabId) {
      return outgoing.interactionContext;
    }
    if (prepared.context?.ok !== false && prepared.context?.task?.page?.tabId) {
      const context = prepared.context;
      prepared.context = null;
      return context;
    }
    const begin = globalThis.__claudeSidebarInteraction?.beginMessage;
    if (typeof begin !== 'function') {
      return {
        ok: false,
        code: 'browser_interaction_runtime_missing',
        bindingRequired: true,
        message: 'The chat message was not sent until a browser page could be resolved.',
      };
    }
    return begin({
      prompt: messagePrompt(outgoing),
      sessionId: outgoing.sessionId || null,
      taskId: outgoing.requestId ? `task-${outgoing.requestId}` : undefined,
    });
  }
  function dispatchBindingFailure(port, outgoing, context) {
    try {
      port.onMessage?.dispatch?.({
        type: 'error',
        requestId: outgoing.requestId || null,
        error: `页面绑定失败：${context?.code || 'unknown'}`,
        detail: context,
      });
    } catch {}
    try {
      chrome.runtime.sendMessage({
        type: 'claude_sidebar_interaction',
        action: 'progress',
        phase: 'error',
        label: '页面绑定失败',
        detail: context?.code || 'unknown',
      });
    } catch {}
  }
  function wrapPort(port) {
    if (!port || port.__claudeSidebarCompatWrapped) return port;
    try {
      const original = port.postMessage.bind(port);
      port.postMessage = function(message) {
        if (!message || typeof message !== 'object' || !CHAT_TYPES.has(String(message.type || ''))) {
          return original(message);
        }
        const outgoing = enrichAttachments({ ...message });
        prepared.sendChain = prepared.sendChain
          .catch(() => undefined)
          .then(async () => {
            const context = await ensureInteractionContext(outgoing);
            if (!context?.ok || !context?.task?.page?.tabId) {
              dispatchBindingFailure(port, outgoing, context || { ok: false, code: 'browser_page_binding_missing' });
              return;
            }
            outgoing.interactionContext = context;
            original(outgoing);
          })
          .catch((error) => {
            dispatchBindingFailure(port, outgoing, {
              ok: false,
              code: 'browser_page_binding_failed',
              error: String(error?.message || error),
            });
          });
        return undefined;
      };
      Object.defineProperty(port, '__claudeSidebarCompatWrapped', { value: true });
    } catch {}
    return port;
  }
  function patchConnectNative() {
    if (!chrome?.runtime?.connectNative || chrome.runtime.connectNative.__claudeSidebarCompatV0138) return;
    const original = chrome.runtime.connectNative.bind(chrome.runtime);
    const patched = (...args) => wrapPort(original(...args));
    patched.__claudeSidebarCompatV0138 = true;
    chrome.runtime.connectNative = patched;
  }
  function installLifecycleCapture() {
    document.addEventListener('submit', async (event) => {
      if (prepared.replaying || !globalThis.__claudeSidebarInteraction?.beginMessage) return;
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.contains(composerInput())) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const context = await globalThis.__claudeSidebarInteraction.beginMessage({ prompt: inputText() });
      if (!context?.ok) return;
      prepared.context = context;
      prepared.replaying = true;
      try { form.requestSubmit(event.submitter || undefined); }
      finally { queueMicrotask(() => { prepared.replaying = false; }); }
    }, true);
  }
  patchConnectNative();
  installLifecycleCapture();
  globalThis.__claudeSidebarCompatBridge = { wrapPort, ensureInteractionContext };
})();
