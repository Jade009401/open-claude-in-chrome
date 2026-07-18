(() => {
  'use strict';
  if (globalThis.__CLAUDE_SIDEBAR_ENTRY_TAKEOVER_V0145__) return;
  globalThis.__CLAUDE_SIDEBAR_ENTRY_TAKEOVER_V0145__ = true;

  const CANONICAL_CHAT_HOST = 'com.sunny.claude_sidebar_chat';
  const LEGACY_CHAT_HOSTS = new Set([
    'com.anthropic.claude_sidebar_chat',
  ]);

  function canonicalizeHost(name) {
    const value = String(name || '');
    return LEGACY_CHAT_HOSTS.has(value) ? CANONICAL_CHAT_HOST : value;
  }

  function patchConnectNative() {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.connectNative || runtime.connectNative.__claudeSidebarEntryTakeoverV0145) return;
    const original = runtime.connectNative.bind(runtime);
    const patched = function(name, ...rest) {
      const requested = String(name || '');
      const canonical = canonicalizeHost(requested);
      const port = original(canonical, ...rest);
      try {
        Object.defineProperty(port, '__claudeSidebarRequestedNativeHost', { value: requested, configurable: true });
        Object.defineProperty(port, '__claudeSidebarCanonicalNativeHost', { value: canonical, configurable: true });
      } catch {}
      return port;
    };
    patched.__claudeSidebarEntryTakeoverV0145 = true;
    patched.__claudeSidebarOriginal = original;
    runtime.connectNative = patched;
  }

  function patchSendNativeMessage() {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.sendNativeMessage || runtime.sendNativeMessage.__claudeSidebarEntryTakeoverV0145) return;
    const original = runtime.sendNativeMessage.bind(runtime);
    const patched = function(name, ...rest) {
      return original(canonicalizeHost(name), ...rest);
    };
    patched.__claudeSidebarEntryTakeoverV0145 = true;
    patched.__claudeSidebarOriginal = original;
    runtime.sendNativeMessage = patched;
  }

  patchConnectNative();
  patchSendNativeMessage();

  globalThis.__claudeSidebarEntryTakeover = Object.freeze({
    version: '0.15.3',
    canonicalChatHost: CANONICAL_CHAT_HOST,
    legacyChatHosts: [...LEGACY_CHAT_HOSTS],
    canonicalizeHost,
  });
})();
