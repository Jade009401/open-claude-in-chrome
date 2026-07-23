// Claude Sidebar v0.15.3 full background service worker.
self.addEventListener('unhandledrejection', (event) => event.preventDefault());
const NATIVE_HOST_NAME = 'com.anthropic.open_claude_in_chrome';
importScripts("browser-task-runtime.js", "universal-browser-map-core.js", "universal-map-kernel.js", "lark-reader-core.js", "virtual-scroll-seek.js", "lark-deep-reader.js");
const larkDeepReadCache = new Map();
const nativeOutboundQueue = [];
const MAX_NATIVE_OUTBOUND_QUEUE = 200;
const inflightToolRequests = new Map();
const completedToolResponses = new Map();
// Abort propagation: when the guard declares a request terminal, every
// long-running loop working for it must actually STOP. Without this, a
// timed-out read kept scrolling the page as a zombie (observed: two orphan
// seek loops from two different turns running in parallel).
const abortedToolRequests = new Map();
function markRequestAborted(requestKey) {
  abortedToolRequests.set(String(requestKey), Date.now());
  for (const [key, at] of abortedToolRequests) if (Date.now() - at > 15 * 60 * 1000) abortedToolRequests.delete(key);
}
function isRequestAborted(requestKey) {
  return requestKey !== undefined && requestKey !== null && abortedToolRequests.has(String(requestKey));
}
// User-initiated STOP: abort every inflight request immediately.
globalThis.__claudeSidebarAbortAllInflight = (reason = 'user_stop') => {
  for (const [key, entry] of inflightToolRequests) {
    markRequestAborted(key);
    try { entry.cancel?.(String(reason)); } catch {}
  }
};
const EXTENSION_BOOT_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
// Execution guard is IDLE-based: genuine progress (heartbeats, per-section
// read plan advances) re-arms it, so long-but-healthy builds/reads survive.
// A hard cap still bounds every execution. Both sit below the host's limits
// (idle 90s < host 180s, hard 540s < host 600s) so the extension reaches a
// terminal state and frees the inflight slot before the host gives up.
const TOOL_EXECUTION_IDLE_MS = 90000;
const TOOL_EXECUTION_HARD_MS = 540000;
let lastNativeDisconnectError = null;
let lastPrimaryBootId = null;


let nativePort = null;
const attachedTabs = new Map();
const consoleMessages = new Map();
const networkRequests = new Map();
const screenshotStore = new Map();

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  if (!nativePort) connectNativeHost();
  else sendExtensionHello('keepalive');
});

function buildExtensionHello(reason = 'connect') {
  return {
    type: 'extension_hello',
    version: '0.15.3',
    protocolVersion: 13,
    ready: true,
    runtime: 'browser-session-v3',
    bootId: EXTENSION_BOOT_ID,
    reason,
    sentAt: new Date().toISOString(),
  };
}
function sendExtensionHello(reason = 'connect') {
  return postNative(buildExtensionHello(reason));
}

function connectNativeHost() {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort.onMessage.addListener((message) => {
      if (message?.type === 'request_extension_hello') {
        handlePrimaryHelloRequest(message);
        return;
      }
      if (message?.type === 'tool_cancel' && message.id) {
        cancelToolRequest(String(message.id), message.reason);
        return;
      }
      if (message?.type === 'tool_request' && message.id) handleToolRequest(message.id, message.tool, message.args || {});
    });
    nativePort.onDisconnect.addListener(() => {
      lastNativeDisconnectError = chrome.runtime.lastError?.message || 'native_port_disconnected';
      nativePort = null;
      setTimeout(connectNativeHost, 1500);
    });
    sendExtensionHello('native_port_connected');
    flushNativeQueue();
  } catch {
    nativePort = null;
    setTimeout(connectNativeHost, 2000);
  }
}

function postNative(message) {
  if (nativePort) {
    try { nativePort.postMessage(message); return true; } catch {}
  }
  nativeOutboundQueue.push(message);
  if (nativeOutboundQueue.length > MAX_NATIVE_OUTBOUND_QUEUE) nativeOutboundQueue.splice(0, nativeOutboundQueue.length - MAX_NATIVE_OUTBOUND_QUEUE);
  return false;
}
function flushNativeQueue() {
  if (!nativePort) return;
  while (nativeOutboundQueue.length) {
    const message = nativeOutboundQueue[0];
    try { nativePort.postMessage(message); nativeOutboundQueue.shift(); }
    catch { break; }
  }
}
// Human-readable progress for the sidepanel: the user must see WHAT is
// happening ("reading section 12/25"), not just which tool is running.
const PROGRESS_LABELS = {
  read_plan_section: (d) => `正在读取第 ${d.index}/${d.total} 节${d.ordinal != null && Number.isFinite(Number(d.ordinal)) ? `（第${d.ordinal}条）` : ''}`,
  lark_locate_seeking: (d) => `正在滚动定位目标…（第 ${d.attempt} 次尝试）`,
  lark_snapshot_transfer: (d) => `正在传输文档内容 ${d.transferredBlocks}/${d.blockCount} 块`,
  lark_frame_scanning: () => '正在扫描文档结构…',
  lark_browser_session_connecting: () => '正在连接文档会话…',
  lark_browser_session_restored: (d) => `已恢复文档会话（${d.blockCount} 块）`,
  lark_scan_resuming: (d) => `扫描接力续跑（已有 ${d.blockCount} 块）`,
  lark_service_worker_cache_hit: () => '命中本地文档缓存 ✓',
};
let lastUiProgressAt = 0;
function sendProgress(id, stage, detail = {}) {
  if (!id) return;
  // Genuine execution progress re-arms the idle guard for this request;
  // duplicate echoes must not keep a wedged request alive.
  if (stage !== 'duplicate_request_waiting') inflightToolRequests.get(String(id))?.touch?.();
  const labelFor = PROGRESS_LABELS[stage];
  if (labelFor && Date.now() - lastUiProgressAt > 2000) {
    lastUiProgressAt = Date.now();
    try { globalThis.__claudeSidebarBrowserTaskRuntime?.progressDetail?.(labelFor(detail || {})); } catch {}
  }
  postNative({ id, type: 'tool_progress', progress: { stage, at: new Date().toISOString(), ...detail } });
}
// A new MCP primary owns a fresh request-id space; entries from the previous
// primary can only collide with it or leak. A reconnect of the SAME primary
// (same primaryBootId) keeps state untouched.
function handlePrimaryHelloRequest(message) {
  const bootId = String(message?.primaryBootId || '');
  if (bootId && lastPrimaryBootId && bootId !== lastPrimaryBootId) {
    for (const [, entry] of inflightToolRequests) entry.cancel?.('superseded_by_new_primary');
    inflightToolRequests.clear();
    completedToolResponses.clear();
  }
  if (bootId) lastPrimaryBootId = bootId;
  sendExtensionHello('native_host_request');
}
function cancelToolRequest(key, reason) {
  inflightToolRequests.get(key)?.cancel?.(String(reason || 'cancelled_by_host'));
}
function argsFingerprint(args) {
  try { return JSON.stringify(args ?? null) || 'null'; } catch { return 'unserializable'; }
}
function rememberCompletedResponse(id, message) {
  const fingerprint = inflightToolRequests.get(String(id))?.fingerprint ?? null;
  completedToolResponses.set(String(id), { message, fingerprint, completedAt: Date.now() });
  for (const [key, value] of completedToolResponses) {
    if (Date.now() - Number(value?.completedAt || 0) > 5 * 60 * 1000) completedToolResponses.delete(key);
  }
  while (completedToolResponses.size > 100) completedToolResponses.delete(completedToolResponses.keys().next().value);
}
function sendResponse(id, result) {
  globalThis.__claudeSidebarBrowserTaskRuntime?.toolCompleted?.(id, true);
  const message = { id, type: 'tool_response', result };
  rememberCompletedResponse(id, message);
  postNative(message);
}
function sendError(id, error) {
  globalThis.__claudeSidebarBrowserTaskRuntime?.toolCompleted?.(id, false, error);
  const message = { id, type: 'tool_error', error: String(error?.message || error) };
  rememberCompletedResponse(id, message);
  postNative(message);
}

async function getTab(tabId) {
  if (tabId) return chrome.tabs.get(Number(tabId));
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs.length) tabs = await chrome.tabs.query({ active: true });
  return tabs[0] || null;
}

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attachedTabs.set(tabId, { domains: new Set() });
}
async function ensureDomain(tabId, domain) {
  await ensureAttached(tabId);
  const state = attachedTabs.get(tabId);
  if (state.domains.has(domain)) return;
  await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`, {});
  state.domains.add(domain);
}
async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}
async function sendContentMessage(tabId, message) {
  try { return await chrome.tabs.sendMessage(tabId, message); }
  catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}
async function resolveRef(tabId, ref) {
  const response = await sendContentMessage(tabId, { type: 'getRefCoordinates', ref });
  return response?.result || null;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isLarkDocumentUrl(value) {
  return /(?:larksuite|feishu)\.com\/(?:docx|docs|wiki|base|sheet|mindnotes|drive)\//i.test(String(value || ''))
    || /(?:larksuite|feishu)\.com/i.test(String(value || ''));
}
async function resolveLarkDocumentTab(args = {}) {
  const runtime = globalThis.__claudeSidebarBrowserTaskRuntime;
  if (runtime && (args.pageAlias || args.pageId || args.pageQuery)) {
    const selected = await runtime.handleAction('task_for_tool', {
      pageAlias: args.pageAlias,
      pageId: args.pageId,
      pageQuery: args.pageQuery,
    });
    if (!selected?.ok) return selected;
    try {
      const tab = await chrome.tabs.get(Number(selected.identity.tabId));
      if (!isLarkDocumentUrl(tab.url)) return { ok: false, code: 'explicit_target_not_lark_document', target: selected.identity, retryable: false };
      return { ok: true, tab, selectionReason: selected.source || 'project_page' };
    } catch (error) {
      return { ok: false, code: 'target_page_closed', tabId: selected.identity?.tabId || null, error: String(error), retryable: false };
    }
  }
  const explicitTabId = Number(args.tabId || 0);
  if (explicitTabId) {
    try {
      const tab = await chrome.tabs.get(explicitTabId);
      if (!isLarkDocumentUrl(tab.url)) return { ok: false, code: 'explicit_target_not_lark_document', tabId: explicitTabId, url: tab.url || null, retryable: false };
      return { ok: true, tab, selectionReason: 'explicit_tab' };
    } catch (error) {
      return { ok: false, code: 'target_page_closed', tabId: explicitTabId, error: String(error), retryable: false };
    }
  }
  if (runtime) {
    const bound = await runtime.handleAction('task_for_tool', {});
    if (bound?.ok && bound.identity?.tabId && isLarkDocumentUrl(bound.identity.url)) {
      try {
        const tab = await chrome.tabs.get(Number(bound.identity.tabId));
        return { ok: true, tab, selectionReason: bound.source || 'bound_task_page' };
      } catch {}
    }
    if (bound && ['task_cancelled','task_paused_page_changed','target_page_changed','target_origin_changed','pinned_page_unavailable'].includes(bound.code)) return bound;
  }
  let candidates = (await chrome.tabs.query({})).filter((tab) => tab.id && isLarkDocumentUrl(tab.url));
  if (!candidates.length) return { ok: false, code: 'lark_document_not_open', retryable: false, candidates: [] };
  const preferredTitle = String(args.preferredTitle || args.documentTitle || '').trim().toLowerCase();
  if (preferredTitle) {
    const titleMatches = candidates.filter((tab) => String(tab.title || '').toLowerCase().includes(preferredTitle));
    if (titleMatches.length === 1) return { ok: true, tab: titleMatches[0], selectionReason: 'preferred_title' };
    if (titleMatches.length > 1) candidates = titleMatches;
  }
  const activeLark = candidates.find((tab) => tab.active);
  if (activeLark) return { ok: true, tab: activeLark, selectionReason: 'active_lark_tab' };
  if (candidates.length === 1) return { ok: true, tab: candidates[0], selectionReason: 'unique_open_lark_document' };
  const sorted = [...candidates].sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0));
  if (sorted[0] && Number(sorted[0].lastAccessed || 0) > Number(sorted[1]?.lastAccessed || 0)) {
    return { ok: true, tab: sorted[0], selectionReason: 'most_recent_lark_document', alternatives: sorted.slice(1, 6).map((tab) => ({ tabId: tab.id, title: tab.title || '', url: tab.url || '' })) };
  }
  return { ok: false, code: 'multiple_lark_documents', retryable: false, candidates: sorted.slice(0, 20).map((tab) => ({ tabId: tab.id, title: tab.title || '', url: tab.url || '', active: Boolean(tab.active), lastAccessed: tab.lastAccessed || null })), resolution: 'Pass tabId, pageAlias, or documentTitle.' };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId); consoleMessages.delete(tabId); networkRequests.delete(tabId);
});
chrome.debugger.onDetach.addListener((source) => attachedTabs.delete(source.tabId));
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (method === 'Runtime.consoleAPICalled') {
    const list = consoleMessages.get(tabId) || [];
    list.push({ type: params.type, text: (params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' '), timestamp: Date.now() });
    if (list.length > 1000) list.splice(0, list.length - 1000);
    consoleMessages.set(tabId, list);
  }
  if (method === 'Network.requestWillBeSent') {
    const list = networkRequests.get(tabId) || [];
    list.push({ requestId: params.requestId, url: params.request?.url, method: params.request?.method, type: params.type, timestamp: Date.now() });
    if (list.length > 2000) list.splice(0, list.length - 2000);
    networkRequests.set(tabId, list);
  }
  if (method === 'Network.responseReceived') {
    const list = networkRequests.get(tabId) || [];
    const existing = [...list].reverse().find((entry) => entry.requestId === params.requestId);
    if (existing) Object.assign(existing, { status: params.response?.status, mimeType: params.response?.mimeType });
  }
});

async function screenshot(tabId, region = null) {
  const params = { format: 'jpeg', quality: 60, captureBeyondViewport: false };
  if (region) params.clip = { x: region[0], y: region[1], width: region[2] - region[0], height: region[3] - region[1], scale: 1 };
  const result = await cdp(tabId, 'Page.captureScreenshot', params);
  const imageId = `screenshot_${Date.now()}`;
  screenshotStore.set(imageId, result.data);
  while (screenshotStore.size > 10) screenshotStore.delete(screenshotStore.keys().next().value);
  return { imageId, base64: result.data };
}

function bufToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}

// On-demand multimodal capture of one image anchor. Primary path = extension-
// privileged fetch of the element's original source bytes (bypasses the page's
// CORS, so cross-origin CDN images come back at native resolution), normalized
// to a model-optimal max edge. Fallback (canvas / CSS-background / no source /
// CORS-blocked) = CDP screenshot clipped to the element rect. Returns base64 the
// host hands to the model as a native image block (verified on Claude Code 2.1.210).
const IMAGE_MAX_EDGE = 1568;

// Shared tail: decode raw image bytes and normalize to a model-optimal max edge,
// returning the base64 image block the host hands the model natively.
async function normalizeBlobToImageBlock(blob, source, degraded = false) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bmp.width, bmp.height));
  const cw = Math.max(1, Math.round(bmp.width * scale));
  const ch = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(cw, ch);
  canvas.getContext('2d').drawImage(bmp, 0, 0, cw, ch);
  const out = await canvas.convertToBlob({ type: 'image/png' });
  return { ok: true, image: { base64: bufToBase64(await out.arrayBuffer()), mimeType: 'image/png', source, width: cw, height: ch, degraded } };
}

// Extension-privileged fetch of source bytes (bypasses page CORS). data:/blob:
// URLs (canvas.toDataURL / serialized svg) are fetchable from the worker too.
async function fetchImageBytes(src) {
  const resp = await fetch(src, { credentials: 'include' });
  if (!resp.ok) return null;
  return resp.blob();
}

// Faithful last resort for opaque/tainted visuals: CDP screenshot clipped to the
// element's absolute-page rect. A diagram IS visual content, so a clip is a true
// capture, not a mask.
async function captureRectViaCdp(tabId, rect) {
  const clip = { x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height), scale: 1 };
  const shot = await cdp(tabId, 'Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
  if (shot?.data) return { ok: true, image: { base64: shot.data, mimeType: 'image/png', source: 'rendered', width: Math.round(rect.width), height: Math.round(rect.height), degraded: true } };
  return null;
}

// Lark virtual-scroll documents store NO stable domPath for image/diagram blocks —
// the collector records the block's coordinates only. On-demand capture reuses the
// block's collected virtualTop (scroll-container-absolute pixel offset): scroll the
// Lark scroller to that coordinate, let virtualization mount the block, then find
// and capture the visual element. A SINGLE bounded scroll with NO text matching, so
// it cannot oscillate — the failure mode of the earlier lark_locate reuse (which
// required query text that image blocks do not have). Falls back to a proportional
// ordinal jump when virtualTop is absent (pre-rebuild maps) and totalBlocks is
// known; never falls back to the text seek.
async function captureLarkImageAnchor(tabId, anchor, requestId, totalBlocks = null) {
  const virtualTop = Number(anchor?.locatorEvidence?.virtualTop);
  const startOrdinal = Number(anchor?.range?.startOrdinal ?? anchor?.locatorEvidence?.blockOrdinal);
  const sourceId = anchor?.locatorEvidence?.sourceId || null;
  const kindHint = String(anchor.label || '').toLowerCase() === 'diagram' ? 'diagram' : 'image';
  const frameId = Number(anchor.frameId || 0);
  const total = Number.isFinite(Number(totalBlocks)) ? Number(totalBlocks) : null;
  if (!Number.isFinite(virtualTop) && !(Number.isFinite(startOrdinal) && total)) {
    // No pixel coordinate and no way to estimate one → do NOT fall back to the text
    // seek (it hangs). Ask for a refresh so the anchor gains virtualTop.
    return { ok: false, code: 'image_needs_map_refresh', capability: 'visual_only', terminal: true, retryRequiresExplicitRefresh: true };
  }

  const finderExec = await chrome.scripting.executeScript({
    target: { tabId: Number(tabId), frameIds: [frameId] },
    world: 'MAIN',
    func: async (opts) => {
      const { virtualTop, startOrdinal, totalBlocks, targetSourceId, kindHint, minEdge } = opts;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
      const abs = (r) => ({ x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height });

      // Pick the dominant vertical scroll container — the same coordinate space the
      // collector measured virtualTop against (Lark's main document scroller).
      function findScroller() {
        let best = null; let bestScore = -1; const seen = new Set();
        const cands = [document.scrollingElement, document.documentElement, document.body, ...document.querySelectorAll('*')];
        for (const el of cands) {
          if (!el || seen.has(el)) continue; seen.add(el);
          const isDoc = el === document.scrollingElement || el === document.documentElement || el === document.body;
          let width; try { width = isDoc ? window.innerWidth : el.getBoundingClientRect().width; } catch { continue; }
          const ch = isDoc ? window.innerHeight : el.clientHeight;
          const sh = isDoc ? Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) : el.scrollHeight;
          if (ch < 120 || width < Math.max(260, window.innerWidth * 0.25) || sh - ch <= 80) continue;
          if (!isDoc) { let ov = ''; try { ov = getComputedStyle(el).overflowY; } catch {} if (!/(auto|scroll|overlay)/.test(ov)) continue; }
          const blocks = (isDoc ? document.body : el).querySelectorAll('[data-block-id],[data-record-id],[class*="block" i],p,li').length;
          const score = blocks * 300 + Math.min(sh - ch, 300000);
          if (score > bestScore) { bestScore = score; best = { el, isDoc }; }
        }
        return best;
      }
      const scroller = findScroller();
      const setTop = (t) => { if (!scroller || scroller.isDoc) window.scrollTo(0, t); else scroller.el.scrollTop = t; };
      const range = scroller
        ? (scroller.isDoc
          ? Math.max(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight)
          : Math.max(0, scroller.el.scrollHeight - scroller.el.clientHeight))
        : Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

      // Land the block's coordinate ~35% down the viewport so it mounts and is not
      // clipped at an edge. virtualTop is primary; proportional ordinal is fallback.
      let target = Number.isFinite(virtualTop)
        ? virtualTop - window.innerHeight * 0.35
        : (Number.isFinite(startOrdinal) && totalBlocks ? (startOrdinal / totalBlocks) * range - window.innerHeight * 0.35 : 0);
      target = Math.max(0, Math.min(target, range));
      setTop(target);
      await raf(); await raf(); await sleep(240); setTop(target); await raf(); await sleep(120);

      const inView = (el) => { const r = el.getBoundingClientRect(); return r.width >= minEdge && r.height >= minEdge && r.bottom > 0 && r.top < window.innerHeight; };
      const sidSelector = (id) => {
        const esc = (window.CSS && CSS.escape) ? CSS.escape(String(id)) : String(id).replace(/["\\]/g, '\\$&');
        return `[data-block-id="${esc}"],[data-node-id="${esc}"],[data-record-id="${esc}"]`;
      };
      // Exact match when the collector captured a sourceId; scroll it fully centered.
      let block = null;
      if (targetSourceId) {
        try { block = document.querySelector(sidSelector(targetSourceId)); } catch {}
        if (!block) { try { block = document.getElementById(String(targetSourceId)); } catch {} }
      }
      if (block) { try { block.scrollIntoView({ block: 'center' }); } catch {} await raf(); await sleep(80); }

      let list = [];
      if (block) {
        list = [...block.querySelectorAll('img,picture,canvas,svg')].filter(inView);
        if (!list.length) return { mode: 'rect', rect: abs(block.getBoundingClientRect()) };
        list.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return rb.width * rb.height - ra.width * ra.height; });
      } else {
        // Anonymous block (e.g. diagram svg/canvas with no data-block-id): the scroll
        // centered the coordinate, so pick the type-matching visual nearest center.
        const selector = kindHint === 'diagram' ? 'canvas,svg' : 'img,picture';
        const cy = window.innerHeight / 2;
        list = [...document.querySelectorAll(selector)].filter(inView)
          .sort((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            return Math.abs((ra.top + ra.bottom) / 2 - cy) - Math.abs((rb.top + rb.bottom) / 2 - cy);
          });
      }
      if (!list.length) return { mode: 'none' };
      const pick = list[0];
      const tag = (pick.tagName || '').toLowerCase();
      const rect = abs(pick.getBoundingClientRect());
      if (tag === 'img') return { mode: 'img', src: pick.currentSrc || pick.src || '', rect };
      if (tag === 'picture') { const im = pick.querySelector('img'); return { mode: 'img', src: im ? (im.currentSrc || im.src || '') : '', rect }; }
      if (tag === 'canvas') { try { return { mode: 'canvas', dataUrl: pick.toDataURL('image/png'), rect }; } catch { return { mode: 'rect', rect }; } }
      if (tag === 'svg') {
        try {
          const clone = pick.cloneNode(true);
          const r = pick.getBoundingClientRect();
          if (!clone.getAttribute('width')) clone.setAttribute('width', Math.round(r.width));
          if (!clone.getAttribute('height')) clone.setAttribute('height', Math.round(r.height));
          if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
          const xml = new XMLSerializer().serializeToString(clone);
          return { mode: 'svg', dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`, rect };
        } catch { return { mode: 'rect', rect }; }
      }
      return { mode: 'rect', rect };
    },
    args: [{ virtualTop: Number.isFinite(virtualTop) ? virtualTop : null, startOrdinal: Number.isFinite(startOrdinal) ? startOrdinal : null, totalBlocks: total, targetSourceId: sourceId, kindHint, minEdge: 48 }],
  });
  const found = finderExec?.[0]?.result;
  if (!found || found.mode === 'none') return { ok: false, code: 'image_element_not_found', capability: 'visual_only', terminal: true };

  // Capture by type — lossless when a real source exists, screenshot otherwise.
  try {
    if (found.mode === 'img' && found.src && /^(https?:|data:|blob:)/i.test(found.src)) {
      const blob = await fetchImageBytes(found.src);
      if (blob) return await normalizeBlobToImageBlock(blob, 'fetched');
    } else if ((found.mode === 'canvas' || found.mode === 'svg') && found.dataUrl) {
      const blob = await fetchImageBytes(found.dataUrl);
      if (blob) return await normalizeBlobToImageBlock(blob, found.mode);
    }
  } catch { /* fall through to screenshot */ }
  if (found.rect) {
    const shot = await captureRectViaCdp(tabId, found.rect).catch(() => null);
    if (shot) return shot;
  }
  return { ok: false, code: 'image_capture_failed', capability: 'visual_only', terminal: true };
}

// On-demand capture of one image anchor. Lark blocks (no domPath) take the
// coordinate-seek path; everything else (generic_dom) resolves its concrete,
// stable domPath directly.
async function captureImageAnchor(tabId, anchor, requestId, totalBlocks = null) {
  const domPath = anchor?.locatorEvidence?.domPath;
  const frameId = Number(anchor.frameId || 0);
  const isLarkBlock = !domPath
    && (String(anchor?.locatorEvidence?.collector || '') === 'lark_document'
      || /^document:block/.test(String(anchor?.locator || '')));
  if (isLarkBlock) return captureLarkImageAnchor(tabId, anchor, requestId, totalBlocks);

  const locate = async () => {
    if (!domPath) return { ok: false, code: 'dom_path_missing' };
    const located = await chrome.scripting.executeScript({
      target: { tabId: Number(tabId), frameIds: [frameId] },
      world: 'MAIN',
      func: (path) => {
        const resolvePath = (value) => {
          const groups = String(value || '').split(/\s*>>>\s*/);
          let root = document; let found = null;
          for (let i = 0; i < groups.length; i += 1) {
            try { found = root.querySelector(groups[i]); } catch { return null; }
            if (!found) return null;
            if (i < groups.length - 1) root = found.shadowRoot;
          }
          return found;
        };
        const node = resolvePath(path);
        if (!node) return { ok: false, code: 'dom_target_not_materialized' };
        try { node.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
        const r = node.getBoundingClientRect();
        const tag = String(node.tagName || '').toLowerCase();
        let src = '';
        if (tag === 'img') src = node.currentSrc || node.src || '';
        else if (tag === 'image') src = node.getAttribute('href') || node.getAttribute('xlink:href') || '';
        return { ok: true, src, tag, w: Number(node.naturalWidth || 0), h: Number(node.naturalHeight || 0), rect: { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height } };
      },
      args: [domPath],
    });
    return located?.[0]?.result || { ok: false, code: 'read_no_result' };
  };

  const meta = await locate();
  if (!meta?.ok) return { ok: false, code: meta?.code || 'image_target_not_materialized', capability: 'visual_only', terminal: true };
  // Primary: privileged fetch of the original source bytes.
  if (meta.src && /^(https?:|data:|blob:)/i.test(meta.src)) {
    try {
      const blob = await fetchImageBytes(meta.src);
      if (blob) return await normalizeBlobToImageBlock(blob, 'fetched');
    } catch { /* fall through to render capture */ }
  }
  // Fallback: CDP screenshot clipped to the element rect (canvas/CSS-bg/CORS).
  const shot = await captureRectViaCdp(tabId, meta.rect).catch(() => null);
  if (shot) return shot;
  return { ok: false, code: 'image_capture_failed', capability: 'visual_only', terminal: true };
}


function isRetryableLarkTransportError(error) {
  return /context invalidated|frame.*removed|no frame with id|cannot access contents|message port closed|receiving end does not exist|execution context|tab was closed|transport|disconnected|frame injection failed|frame unavailable/i.test(String(error?.message || error || ''));
}

async function withProgressHeartbeat(requestId, stage, detail, work) {
  let tick = 0;
  sendProgress(requestId, stage, { ...detail, tick });
  const timer = setInterval(() => {
    tick += 1;
    sendProgress(requestId, stage, { ...detail, tick, elapsedMs: tick * 8000 });
  }, 8000);
  try { return await work(); }
  finally { clearInterval(timer); }
}

async function listLarkFrames(tabId) {
  let frames = [];
  try {
    if (chrome.webNavigation?.getAllFrames) frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {}
  if (!Array.isArray(frames) || !frames.length) frames = [{ frameId: 0, parentFrameId: -1, url: null }];
  const seen = new Set();
  return frames.filter((frame) => {
    const id = Number(frame?.frameId);
    if (!Number.isInteger(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function injectLarkFrameRuntime(tabId, requestedFrameIds = null) {
  const frames = await listLarkFrames(tabId);
  const requested = requestedFrameIds ? new Set(requestedFrameIds.map(Number)) : null;
  const results = [];
  for (const frame of frames) {
    const frameId = Number(frame.frameId);
    if (requested && !requested.has(frameId)) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        world: 'MAIN',
        files: ['lark-reader-core.js', 'virtual-scroll-seek.js', 'lark-deep-reader.js'],
      });
      results.push({ ok: true, frameId, url: frame.url || null });
    } catch (error) {
      results.push({ ok: false, frameId, url: frame.url || null, code: 'frame_runtime_injection_failed', error: String(error?.message || error) });
    }
  }
  if (!results.some((item) => item.ok)) {
    const failure = new Error(`Lark runtime injection failed in all ${results.length || 1} frame candidates.`);
    failure.code = 'lark_frame_runtime_injection_failed';
    failure.frameInjection = results;
    throw failure;
  }
  return results;
}

async function executeInLarkFrames(tabId, frameIds, func, args = []) {
  const results = [];
  for (const frameId of frameIds) {
    try {
      const executions = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [Number(frameId)] },
        world: 'MAIN',
        func,
        args,
      });
      results.push({ ok: true, frameId: Number(frameId), documentId: executions[0]?.documentId || null, result: executions[0]?.result });
    } catch (error) {
      results.push({ ok: false, frameId: Number(frameId), code: 'frame_execution_failed', error: String(error?.message || error) });
    }
  }
  return results;
}

async function probeLarkFrames(tabId, injectedFrames = null) {
  const frameIds = (injectedFrames || await injectLarkFrameRuntime(tabId)).filter((item) => item.ok).map((item) => item.frameId);
  const executions = await executeInLarkFrames(tabId, frameIds, () => {
    const runtime = globalThis.OpenClaudeLarkDeepReader;
    return runtime?.frameProbe ? runtime.frameProbe() : { ok: false, code: 'deep_reader_runtime_missing' };
  });
  return executions.map((item) => item.ok
    ? { ...(item.result || {}), frameId: item.frameId, documentId: item.documentId || null }
    : item)
    .filter((item) => item?.ok)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

function larkSessionQuality(session = {}) {
  const scan = session.scan || {};
  const body = scan.body || {};
  const termination = String(scan.terminationReason || '');
  const structuralLimit = ['max_blocks_reached', 'max_steps_reached', 'scroll_boundary_not_reached', 'bottom_not_stable'].includes(termination);
  return (scan.reachedBottom === true ? 2_000_000 : 0)
    + (scan.complete === true ? 1_000_000 : 0)
    + (body.evidenceComplete === true ? 750_000 : 0)
    + Math.min(500_000, Number(body.leafTextCharCount || 0) * 8)
    + Math.min(250_000, Number(body.leafTextBlockCount || 0) * 2500)
    + Math.min(100_000, Number(body.headingBlockCount || 0) * 1500)
    + Math.min(100_000, Number(session.probeScore || session.score || 0) * 100)
    + Math.min(50_000, Number(session.blockCount || 0) * 20)
    - (structuralLimit ? 2_000_000 : 0);
}

function reusableLarkScan(scan = {}) {
  const termination = String(scan.terminationReason || '');
  return scan.reachedBottom === true
    && !['max_blocks_reached', 'max_steps_reached', 'scroll_boundary_not_reached', 'bottom_not_stable'].includes(termination);
}

async function discoverStoredLarkFrameSessions(tabId, injectedFrames = null) {
  const frameIds = (injectedFrames || await injectLarkFrameRuntime(tabId)).filter((item) => item.ok).map((item) => item.frameId);
  const executions = await executeInLarkFrames(tabId, frameIds, () => {
    const runtime = globalThis.OpenClaudeLarkDeepReader;
    return runtime?.frameSessionLatest ? runtime.frameSessionLatest() : { ok: false, code: 'deep_reader_runtime_missing' };
  });
  return executions.map((item) => item.ok
    ? { ...(item.result || {}), frameId: item.frameId, documentId: item.documentId || null }
    : item)
    .filter((item) => item?.ok && item.sessionId && Number(item.blockCount || 0) > 0)
    .sort((a, b) => larkSessionQuality(b) - larkSessionQuality(a) || Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
}

async function scanLarkFrameToSession(tabId, frameId, scanOptions) {
  const executions = await executeInLarkFrames(tabId, [frameId], async (options) => {
    const runtime = globalThis.OpenClaudeLarkDeepReader;
    if (!runtime?.frameScanSession) return { ok: false, code: 'deep_reader_session_runtime_missing' };
    try { return await runtime.frameScanSession(options); }
    catch (error) { return { ok: false, code: 'frame_scan_failed', error: String(error?.message || error) }; }
  }, [scanOptions]);
  const execution = executions[0];
  if (!execution?.ok) return { ok: false, code: execution?.code || 'frame_scan_execution_failed', error: execution?.error || null, frameId };
  return { ...(execution.result || { ok: false, code: 'frame_scan_no_result' }), frameId, documentId: execution.documentId || null };
}

async function readLarkFrameSessionBlocks(tabId, session, requestId, transportChunkSize = 200) {
  const blockCount = Number(session.blockCount || 0);
  const chunkSize = Math.max(50, Math.min(250, Number(transportChunkSize || 200)));
  const blocks = [];
  for (let start = 0; start < blockCount; start += chunkSize) {
    const end = Math.min(blockCount - 1, start + chunkSize - 1);
    const executions = await executeInLarkFrames(tabId, [session.frameId], (sessionId, startOrdinal, endOrdinal) => {
      const runtime = globalThis.OpenClaudeLarkDeepReader;
      return runtime?.frameSessionChunk
        ? runtime.frameSessionChunk(sessionId, startOrdinal, endOrdinal)
        : { ok: false, code: 'deep_reader_session_runtime_missing' };
    }, [session.sessionId, start, end]);
    const execution = executions[0];
    const chunk = execution?.ok ? execution.result : null;
    if (!chunk?.ok || !Array.isArray(chunk.blocks)) {
      const error = new Error(`Lark frame session chunk failed in frame ${session.frameId}: ${chunk?.code || execution?.code || 'missing_result'}`);
      error.code = chunk?.code || execution?.code || 'frame_session_chunk_failed';
      error.frameId = session.frameId;
      error.chunk = { start, end };
      throw error;
    }
    blocks.push(...chunk.blocks);
    sendProgress(requestId, 'lark_snapshot_transfer', { transferredBlocks: blocks.length, blockCount, frameId: session.frameId });
  }
  if (blocks.length !== blockCount) {
    const error = new Error(`Lark frame session block count mismatch: expected ${blockCount}, received ${blocks.length}`);
    error.code = 'frame_session_block_count_mismatch';
    throw error;
  }
  return blocks;
}

async function loadStableLarkFrameSnapshot(tabId, args, scanOptions, frameDiagnostics) {
  const requestId = args.__requestId;
  const maxAttempts = Math.max(1, Math.min(4, Number(args.transportRetries || 3)));
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      sendProgress(requestId, 'lark_browser_session_connecting', { attempt, maxAttempts, tabId });
      const injection = await injectLarkFrameRuntime(tabId);
      frameDiagnostics.push(...injection.slice(0, 40).map((item) => ({ stage: 'inject', attempt, ...item })));

      if (!args.refresh) {
        const stored = await discoverStoredLarkFrameSessions(tabId, injection);
        const reusable = stored.find((item) => reusableLarkScan(item.scan)) || stored[0];
        if (reusable) {
          sendProgress(requestId, 'lark_browser_session_restored', { attempt, frameId: reusable.frameId, blockCount: reusable.blockCount });
          const blocks = await readLarkFrameSessionBlocks(tabId, reusable, requestId, args.transportChunkSize);
          return { ...reusable, blocks, restored: true, transportAttempts: attempt };
        }
      }

      const probes = await probeLarkFrames(tabId, injection);
      frameDiagnostics.push(...probes.slice(0, 20).map((probe) => ({ stage: 'probe', attempt, ...probe })));
      if (!probes.length) {
        const error = new Error('No readable Lark frame was found after per-frame runtime injection.');
        error.code = 'lark_document_not_found_in_frames';
        throw error;
      }
      sendProgress(requestId, 'lark_frames_probed', { attempt, frameCount: probes.length, topFrameId: probes[0].frameId });

      const maxFrameCandidates = Math.max(1, Math.min(4, Number(args.maxFrameCandidates || 3)));
      const sessions = [];
      for (const probe of probes.slice(0, maxFrameCandidates)) {
        const session = await withProgressHeartbeat(requestId, 'lark_frame_scanning', { attempt, frameId: probe.frameId, score: probe.score }, () => scanLarkFrameToSession(tabId, probe.frameId, scanOptions));
        frameDiagnostics.push({ stage: 'scan', attempt, frameId: probe.frameId, ok: session.ok === true, code: session.code || null, blockCount: Number(session.blockCount || 0), complete: session.scan?.complete === true, terminationReason: session.scan?.terminationReason || null, error: session.error || null });
        if (session?.ok && session.sessionId && Number(session.blockCount || 0) > 0) sessions.push({ ...session, probeScore: Number(probe.score || 0) });
      }
      sessions.sort((a, b) => larkSessionQuality(b) - larkSessionQuality(a));
      const best = sessions[0];
      if (!best) {
        const error = new Error('Lark frame scan did not produce a reusable session.');
        error.code = 'lark_frame_scan_empty';
        throw error;
      }
      // Strategy-a resume: a deadline-truncated scan stored its partial blocks
      // in the frame session; the next attempt auto-seeds from them and runs
      // against an already-materialized (warm) document, so it converges fast.
      if (best.scan?.terminationReason === 'scan_deadline_reached' && attempt < maxAttempts) {
        sendProgress(requestId, 'lark_scan_resuming', { attempt, blockCount: Number(best.blockCount || 0) });
        lastError = Object.assign(new Error('Scan deadline reached; resuming from stored partial blocks.'), { code: 'scan_deadline_resume' });
        continue;
      }
      const blocks = await readLarkFrameSessionBlocks(tabId, best, requestId, args.transportChunkSize);
      sendProgress(requestId, 'lark_browser_session_ready', { attempt, frameId: best.frameId, blockCount: blocks.length, complete: best.scan?.complete === true });
      return { ...best, blocks, restored: false, transportAttempts: attempt };
    } catch (error) {
      lastError = error;
      frameDiagnostics.push({ stage: 'transport', attempt, ok: false, code: error?.code || (isRetryableLarkTransportError(error) ? 'retryable_transport_error' : 'browser_session_stage_failed'), error: String(error?.message || error), frameId: error?.frameId ?? null, chunk: error?.chunk || null, injection: error?.frameInjection || null });
      sendProgress(requestId, 'lark_browser_session_retry', { attempt, maxAttempts, code: error?.code || null, error: String(error?.message || error), retryable: isRetryableLarkTransportError(error) });
      if (attempt < maxAttempts) await sleep(350 * attempt + Math.floor(Math.random() * 250));
    }
  }
  const error = new Error(`Lark Browser Session recovery exhausted: ${String(lastError?.message || lastError || 'unknown transport error')}`);
  error.code = 'browser_session_recovery_exhausted';
  error.causeCode = lastError?.code || null;
  error.frameDiagnostics = frameDiagnostics;
  throw error;
}


const universalMapCache = new Map();

function parseToolJson(response) {
  const text = response?.content?.find?.((item) => item?.type === 'text')?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function resolveUniversalPage(args = {}) {
  const runtime = globalThis.__claudeSidebarBrowserTaskRuntime;
  if (runtime) {
    const selected = await runtime.handleAction('task_for_tool', {
      tabId: args.tabId,
      pageAlias: args.pageAlias,
      pageId: args.pageId,
      pageQuery: args.pageQuery,
    });
    if (selected?.ok && selected.identity?.tabId) {
      try { return { ok: true, tab: await chrome.tabs.get(Number(selected.identity.tabId)), source: selected.source || 'task_page' }; }
      catch (error) { return { ok: false, code: 'target_page_closed', error: String(error), target: selected.identity }; }
    }
    if (selected && selected.ok === false && selected.code !== 'no_active_task') return selected;
  }
  const tab = await getTab(args.tabId);
  if (!tab?.id) return { ok: false, code: 'target_page_not_found' };
  return { ok: true, tab, source: args.tabId ? 'explicit_tab' : 'active_page' };
}

async function listFrames(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (Array.isArray(frames) && frames.length) return frames.map((frame) => ({ frameId: frame.frameId, url: frame.url || '' }));
  } catch {}
  return [{ frameId: 0, url: '' }];
}

async function scanUniversalFrames(tab, args = {}) {
  const frames = await listFrames(tab.id);
  const fragments = [];
  const evidenceBatches = [];
  const diagnostics = [];
  for (const frame of frames.slice(0, Math.max(1, Math.min(100, Number(args.maxFrames || 30))))) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frame.frameId] }, world: 'MAIN', files: ['universal-browser-map-core.js', 'universal-map-kernel.js', 'universal-browser-map.js'] });
      const execution = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [frame.frameId] },
        world: 'MAIN',
        func: (options) => {
          try {
            const result = globalThis.ClaudeUniversalBrowserMap?.scan?.(options);
            return result ? { ...result, frameUrl: location.href, frameTitle: document.title } : { ok: false, code: 'universal_map_runtime_missing', frameUrl: location.href };
          } catch (error) {
            return { ok: false, code: 'universal_frame_scan_failed', error: String(error), frameUrl: location.href, frameTitle: document.title };
          }
        },
        args: [{ maxNodes: args.maxNodesPerFrame || 6000, evidenceOnly: true }],
      });
      const result = execution?.[0]?.result;
      if (result?.ok) {
        const prefix = `f${frame.frameId}_`;
        const remapNodes = (nodes = []) => {
          const idMap = new Map();
          const prepared = nodes.map((node, index) => {
            const originalId = node.id == null ? null : String(node.id);
            const generatedId = originalId
              ? `${prefix}${originalId}`
              : `${prefix}anon_${index}_${globalThis.ClaudeUniversalBrowserMapCore.hashString(`${node.type || ''}|${node.sourceId || ''}|${node.title || ''}|${node.text || ''}`)}`;
            if (originalId) idMap.set(originalId, generatedId);
            return { node, generatedId };
          });
          return prepared.map(({ node, generatedId }) => ({
            ...node,
            id: generatedId,
            parentId: node.parentId ? idMap.get(String(node.parentId)) || null : null,
            frameId: frame.frameId,
            attributes: { ...(node.attributes || {}), frameUrl: result.frameUrl || frame.url || '' },
          }));
        };
        result.nodes = remapNodes(result.nodes || []);
        for (const rawBatch of result.evidenceBatches || []) {
          evidenceBatches.push({
            ...rawBatch,
            frameId: frame.frameId,
            nodes: remapNodes(rawBatch.nodes || []),
          });
        }
        fragments.push({ ...result, adapter: result.adapter || `frame_${frame.frameId}` });
      } else diagnostics.push({ frameId: frame.frameId, url: frame.url || result?.frameUrl || '', code: result?.code || 'scan_failed', error: result?.error || null });
    } catch (error) {
      diagnostics.push({ frameId: frame.frameId, url: frame.url || '', code: 'frame_injection_failed', error: String(error) });
    }
  }
  return { fragments, evidenceBatches, diagnostics, frameCount: frames.length };
}

async function collectAccessibilityFragment(tabId, args = {}) {
  const nodes = [];
  try {
    const result = await cdp(tabId, 'Accessibility.getFullAXTree', { depth: Math.max(2, Math.min(30, Number(args.axDepth || 12))) });
    const raw = result?.nodes || [];
    const idMap = new Map(raw.map((node) => [node.nodeId, `ax_${node.nodeId}`]));
    for (const item of raw.slice(0, Math.max(100, Math.min(30000, Number(args.maxAxNodes || 10000))))) {
      if (item.ignored) continue;
      const role = String(item.role?.value || 'node');
      const title = String(item.name?.value || '');
      const value = String(item.value?.value || '');
      if (!title && !value && !['RootWebArea','WebArea','application','grid','table','canvas'].includes(role)) continue;
      let type = 'accessibility_node';
      if (/heading/i.test(role)) type = 'document_section';
      else if (/row$/i.test(role)) type = 'table_row';
      else if (/cell|gridcell|columnheader|rowheader/i.test(role)) type = 'table_cell';
      else if (/button|textbox|combobox|checkbox|radio|link/i.test(role)) type = 'control';
      else if (/canvas|application/i.test(role)) type = /figma/i.test(`${title} ${value}`) ? 'figma_canvas' : 'canvas_surface';
      nodes.push({
        id: idMap.get(item.nodeId),
        parentId: item.parentId ? idMap.get(item.parentId) || null : null,
        type,
        role,
        title,
        text: value || title,
        sourceId: item.backendDOMNodeId ? `backendDOM:${item.backendDOMNodeId}` : item.nodeId,
        adapter: 'accessibility',
        frameId: 0,
        confidence: 0.86,
        actionable: /button|textbox|combobox|checkbox|radio|link/i.test(role),
        opaque: /canvas|application/i.test(role) && !title,
        attributes: { backendDOMNodeId: item.backendDOMNodeId || null },
        evidence: { source: 'cdp_accessibility_tree' },
      });
    }
    return { adapter: 'accessibility', nodes, capabilities: ['accessibility_tree'], diagnostics: [], collection: { status: 'snapshot_complete', frontier: 'snapshot_complete', unresolvedRegions: 0, nodeCount: nodes.length } };
  } catch (error) {
    return { adapter: 'accessibility', nodes: [], capabilities: [], diagnostics: [{ code: 'accessibility_tree_failed', error: String(error) }], collection: { status: 'failed', frontier: 'unknown', failed: true, reasons: ['accessibility_tree_failed'], nodeCount: 0 } };
  }
}


async function collectStructuredAppFragment(tab, args = {}) {
  try {
    const response = await toolHandlers.browser_app_inspect({
      tabId: tab.id,
      maxControls: args.maxControls || 1000,
      maxSurfaces: args.maxSurfaces || 30,
      maxNavigationLinks: args.maxNavigationLinks || 300,
      maxDetailPairs: args.maxDetailPairs || 1000,
      maxTextChars: args.maxTextChars || 100000,
    });
    const inspected = parseToolJson(response);
    if (!inspected?.ok) return { adapter: 'structured_app', nodes: [], capabilities: [], diagnostics: [{ code: inspected?.code || 'structured_app_inspect_unavailable', error: inspected?.error || null }] };
    const core = globalThis.ClaudeUniversalBrowserMapCore;
    const fragments = [];
    const tables = [];
    for (const surface of inspected.dataSurfaces || []) {
      if (!Array.isArray(surface.rows) || !surface.rows.length) continue;
      tables.push({
        tableIndex: Number(surface.surfaceIndex || tables.length + 1),
        title: surface.title || surface.label || surface.type || `Data surface ${tables.length + 1}`,
        headers: surface.headers || [],
        rows: surface.rows,
      });
    }
    if (tables.length) fragments.push(core.buildTableNodes(tables, { url: tab.url, adapter: 'structured_app' }));
    const nodes = [];
    const rootId = `app_${core.hashString(`${tab.url}|${inspected.appProfile?.product || 'app'}`)}`;
    nodes.push({ id: rootId, type: 'application', role: 'application', title: inspected.title || tab.title || '', text: inspected.appProfile?.product || '', adapter: 'structured_app', confidence: 0.9, attributes: { appProfile: inspected.appProfile || null } });
    for (const pair of inspected.details || []) {
      nodes.push({ parentId: rootId, type: 'data_field', role: 'definition', title: pair.key || pair.field || '', text: pair.value || '', adapter: 'structured_app', confidence: 0.9, evidence: { source: 'page_detail_pair', sourceUrl: pair.sourceUrl || tab.url } });
    }
    for (const fact of inspected.confirmedFacts || []) {
      nodes.push({ parentId: rootId, type: 'data_field', role: 'definition', title: fact.field || '', text: fact.value || '', adapter: 'structured_app', confidence: 0.96, evidence: { source: fact.sourceType || 'confirmed_fact', sourceUrl: fact.sourceUrl || tab.url, rowIndex: fact.rowIndex ?? null } });
    }
    for (const control of inspected.controls || []) {
      nodes.push({ parentId: rootId, type: 'control', role: control.role || control.type || 'control', title: control.name || control.label || control.text || '', text: control.value || control.text || '', adapter: 'structured_app', actionable: true, confidence: 0.84, attributes: { ref: control.ref || null, href: control.href || null } });
    }
    fragments.push({ adapter: 'structured_app', nodes, capabilities: ['structured_application', 'details', ...(tables.length ? ['data_surfaces'] : [])], diagnostics: [] });
    const combinedNodes = fragments.flatMap((fragment) => fragment.nodes || []);
    const combinedCapabilities = [...new Set(fragments.flatMap((fragment) => fragment.capabilities || []))];
    return { adapter: 'structured_app', nodes: combinedNodes, capabilities: combinedCapabilities, diagnostics: [], collection: { status: 'snapshot_complete', frontier: 'snapshot_complete', unresolvedRegions: 0, nodeCount: combinedNodes.length }, completeness: { complete: true, reasons: [] } };
  } catch (error) {
    return { adapter: 'structured_app', nodes: [], capabilities: [], diagnostics: [{ code: 'structured_app_adapter_failed', error: String(error) }], collection: { status: 'failed', frontier: 'unknown', failed: true, reasons: ['structured_app_adapter_failed'], nodeCount: 0 } };
  }
}

async function collectLarkDocumentFragment(tab, args = {}) {
  if (!isLarkDocumentUrl(tab.url)) return null;
  const core = globalThis.ClaudeUniversalBrowserMapCore;
  const mapResponse = await toolHandlers.lark_deep_read({ ...args, tabId: tab.id, scope: 'map', refresh: args.refresh === true, maxBlocks: args.maxBlocks || 10000 });
  const map = parseToolJson(mapResponse);
  if (!map?.ok || !Number.isFinite(Number(map.blockCount))) {
    return { adapter: 'lark_document', nodes: [], capabilities: [], diagnostics: [{ code: map?.code || 'lark_map_unavailable', error: map?.error || null }], completeness: { complete: false, reasons: [map?.code || 'lark_map_unavailable'] } };
  }
  const blocks = [];
  const chunkSize = Math.max(50, Math.min(250, Number(args.chunkSize || 200)));
  for (let start = 0; start < Number(map.blockCount || 0); start += chunkSize) {
    if (isRequestAborted(args.__requestId)) {
      return { adapter: 'lark_document', nodes: [], capabilities: [], diagnostics: [{ code: 'request_aborted' }], completeness: { complete: false, reasons: ['request_aborted'] } };
    }
    const rangeResponse = await toolHandlers.lark_deep_read({ ...args, tabId: tab.id, scope: 'range', refresh: false, startOrdinal: start, endOrdinal: Math.min(Number(map.blockCount) - 1, start + chunkSize - 1), maxReturnBlocks: chunkSize });
    const range = parseToolJson(rangeResponse);
    if (!range?.ok || !Array.isArray(range.blocks)) {
      return { adapter: 'lark_document', nodes: [], capabilities: [], diagnostics: [{ code: range?.code || 'lark_range_unavailable', startOrdinal: start, error: range?.error || null }], completeness: { complete: false, reasons: [range?.code || 'lark_range_unavailable'] } };
    }
    blocks.push(...range.blocks);
  }
  const fragment = core.buildDocumentNodes(blocks, { title: map.title || tab.title, url: map.url || tab.url, adapter: 'lark_document' });
  // Body text travels with the build so the host can persist it next to the
  // map (2026-07-14 design amendment): same staleness contract as anchors,
  // reads then run from local disk with zero page interaction.
  {
    // Content blocks bypass the kernel's anchor dedup, and Lark's virtual scroll
    // re-captures the same block many times (with different/absent data ids), so
    // the raw stream is heavily duplicated. Collapse ONLY re-captures of the same
    // block: identical normalized text at the same on-screen position
    // (virtualTop within ~8px). Two distinct visible blocks cannot occupy the
    // same pixel position, so this never merges legitimate repeats (e.g. equal
    // table-cell values on different rows). Blocks whose position drifted between
    // captures are kept as-is (no data loss over completeness). Empty /
    // zero-width-only blocks are dropped.
    const stripInvisibles = (s) => String(s || '').replace(/[​‌‍﻿]/g, '');
    const normKey = (s) => stripInvisibles(s).replace(/\s+/g, ' ').trim();
    const POS_BUCKET_PX = 8;
    const seen = new Set();
    let contentChars = 0;
    fragment.contentBlocks = [];
    for (const block of blocks) {
      const cleaned = stripInvisibles(block?.text).trim();
      if (!cleaned) continue;
      const vtBucket = typeof block?.virtualTop === 'number' ? Math.round(block.virtualTop / POS_BUCKET_PX) : 'x';
      const dedupKey = `${normKey(block?.text)}@@${vtBucket}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      if (contentChars + cleaned.length > 800000) break;
      contentChars += cleaned.length;
      fragment.contentBlocks.push({ type: String(block?.type || 'paragraph'), text: cleaned });
    }
  }
  const scan = map.scan || {};
  const reachedStableBottom = scan.reachedBottom === true
    && Number(scan.bottomStableSteps || 0) >= Number(scan.bottomStableRequired || 0);
  const hitStructuralLimit = ['max_blocks_reached', 'max_steps_reached', 'scroll_boundary_not_reached', 'bottom_not_stable']
    .includes(String(scan.terminationReason || ''));
  // The Lark outline is optional navigation evidence. Requirement items are
  // often ordinary paragraphs/lists, so a missing outline must not reject a
  // map after the deep reader reached a stable bottom and transferred every
  // discovered block.
  const outlineMissingCount = Number(scan.outline?.missingCount || 0);
  const outlineStructureComplete = outlineMissingCount === 0;
  // Body evidence is NOT advisory: a scan that reached a stable bottom but
  // extracted no real body text produced a shell map (observed: 124 blocks,
  // zero numbered requirements — every numbered anchor came from the DOM
  // collector, which stops at the rendered viewport and lost item 25).
  // Publishing such a map permanently hides the tail; refuse instead.
  const bodyEvidenceIncomplete = scan.body?.evidenceComplete === false;
  const structureComplete = reachedStableBottom
    && !hitStructuralLimit
    && !bodyEvidenceIncomplete
    && blocks.length === Number(map.blockCount);
  const structureReasons = [];
  if (!reachedStableBottom) structureReasons.push('lark_structure_bottom_unverified');
  if (hitStructuralLimit) structureReasons.push(String(scan.terminationReason || 'lark_structure_limit_reached'));
  if (bodyEvidenceIncomplete) structureReasons.push('lark_body_evidence_incomplete');
  if (blocks.length !== Number(map.blockCount)) structureReasons.push('lark_block_transfer_incomplete');
  fragment.completeness = { complete: structureComplete, reasons: [...new Set(structureReasons)] };
  fragment.collection = {
    status: structureComplete ? 'stable_end' : 'incomplete',
    frontier: reachedStableBottom ? 'stable_end' : 'unknown',
    truncated: hitStructuralLimit,
    limitReached: hitStructuralLimit,
    unresolvedRegions: structureComplete ? 0 : 1,
    passes: Number(scan.steps || scan.passes || 0),
    newNodesOnLastPass: 0,
    nodeCount: fragment.nodes?.length || 0,
    reasons: [...new Set(structureReasons)],
    warnings: outlineStructureComplete ? [] : ['outline_structure_missing_advisory'],
  };
  fragment.diagnostics = [{
    code: 'lark_navigation_structure_scan',
    blockCount: blocks.length,
    sectionCount: map.sections?.length || 0,
    structureComplete,
    sourceContentComplete: scan.complete === true,
    terminationReason: scan.terminationReason || null,
    reachedBottom: scan.reachedBottom === true,
    bottomStableSteps: Number(scan.bottomStableSteps || 0),
    bottomStableRequired: Number(scan.bottomStableRequired || 0),
    outlineMissingCount,
    outlineAdvisoryOnly: true,
    outlineStructureComplete,
    bodyEvidenceComplete: scan.body?.evidenceComplete === true,
    // Container-selection forensics: which scroll containers were discovered,
    // which were scanned, and which one won — pinpoints a shell container
    // beating the real document body (#docx) without another blind iteration.
    scanTarget: scan.target || null,
    targetCandidates: scan.candidateSummaries || null,
    targetCount: scan.targetCount ?? null,
    discoveredTargetCount: scan.discoveredTargetCount ?? null,
    // Extraction forensics: enough to pinpoint WHY body text is missing on the
    // next real-page build without another blind iteration. Local-only data.
    leafTextBlockCount: Number(scan.body?.leafTextBlockCount ?? -1),
    leafTextCharCount: Number(scan.body?.leafTextCharCount ?? -1),
    containerBlockCount: blocks.filter((block) => block.isContainer === true).length,
    blockTypeHistogram: blocks.reduce((histogram, block) => {
      const type = String(block.type || 'unknown');
      histogram[type] = (histogram[type] || 0) + 1;
      return histogram;
    }, {}),
    sampleLeafTexts: blocks
      .filter((block) => block.leaf !== false && !block.isContainer && String(block.text || '').trim())
      .slice(0, 5)
      .map((block) => String(block.text).slice(0, 80)),
    sampleEmptyBlocks: blocks
      .filter((block) => !String(block.text || '').trim())
      .slice(0, 5)
      .map((block) => ({ type: block.type, sourceId: String(block.sourceId || '').slice(0, 40), container: block.isContainer === true })),
  }];
  return fragment;
}

function pageCollectorKind(tab, batches = []) {
  const url = String(tab?.url || '').toLowerCase();
  if (isLarkDocumentUrl(url)) return 'lark';
  if (/figma\.com/.test(url) || batches.some((batch) => batch.collector === 'figma' && batch.nodes?.length)) return 'figma';
  if (/sheets|spreadsheet|excel/.test(url) || batches.some((batch) => batch.collector === 'spreadsheet' && batch.nodes?.length)) return 'spreadsheet';
  if (batches.some((batch) => batch.collector === 'virtual_document' && batch.nodes?.length)) return 'document';
  return 'generic';
}

function applyCollectorPolicy(tab, inputBatches = []) {
  const kernel = globalThis.ClaudeUniversalMapKernel;
  const batches = inputBatches.map((batch) => batch?.schemaVersion
    ? { ...batch, nodes: Array.isArray(batch.nodes) ? batch.nodes : [] }
    : kernel.evidenceBatchFromFragment(batch));
  const kind = pageCollectorKind(tab, batches);
  const profiled = batches.map((batch) => {
    const collector = String(batch.collector || 'unknown');
    const mainFrame = Number(batch.frameId || 0) === 0;
    let role = 'supporting';
    let authority = batch.authority || 'derived';
    if (kind === 'lark' && collector === 'lark_document') role = 'primary';
    else if (kind === 'figma' && collector.includes('figma')) role = 'primary';
    else if (kind === 'spreadsheet' && ['spreadsheet','virtual_table','structured_app'].includes(collector)) role = 'primary';
    else if (kind === 'document' && collector === 'virtual_document') { role = 'primary'; authority = 'authoritative'; }
    else if (kind === 'generic' && mainFrame && collector === 'generic_dom') role = 'primary';
    return { ...batch, role, required: role === 'primary', authority };
  });
  if (!profiled.some((batch) => batch.role === 'primary' && batch.nodes?.length)) {
    const candidate = [...profiled]
      .filter((batch) => batch.nodes?.length)
      .sort((a, b) => Number(b.sourcePriority || 0) - Number(a.sourcePriority || 0))[0];
    if (candidate) {
      candidate.role = 'primary';
      candidate.required = true;
    }
  }
  return profiled;
}

async function buildUniversalMap(args = {}) {
  const resolved = await resolveUniversalPage(args);
  if (!resolved?.ok) return resolved;
  const tab = resolved.tab;
  if (!/^https?:/i.test(tab.url || '')) return { ok: false, code: 'unsupported_page_scheme', tabId: tab.id, url: tab.url || '' };
  const core = globalThis.ClaudeUniversalBrowserMapCore;
  const kernel = globalThis.ClaudeUniversalMapKernel;
  if (!core?.buildMap) return { ok: false, code: 'universal_map_core_missing' };
  if (!kernel?.compileEvidenceBatches) return { ok: false, code: 'universal_map_kernel_missing' };

  const { evidenceBatches: frameBatches, fragments, diagnostics, frameCount } = await scanUniversalFrames(tab, args);
  const batches = [...(frameBatches || [])];
  if (!batches.length) {
    for (const fragment of fragments || []) batches.push(kernel.evidenceBatchFromFragment(fragment, { collector: fragment.adapter || 'universal_page', frameId: Number(fragment.frameId || 0) }));
  }

  const axFragment = await collectAccessibilityFragment(tab.id, args);
  batches.push(kernel.evidenceBatchFromFragment(axFragment, { collector: 'accessibility', role: 'supporting', authority: 'derived' }));
  const structuredAppFragment = await collectStructuredAppFragment(tab, args);
  batches.push(kernel.evidenceBatchFromFragment(structuredAppFragment, { collector: 'structured_app', role: 'supporting', authority: 'derived' }));
  const larkFragment = await collectLarkDocumentFragment(tab, args);
  if (larkFragment) batches.push(kernel.evidenceBatchFromFragment(larkFragment, { collector: 'lark_document', role: 'primary', required: true, authority: 'derived' }));

  const profiledBatches = applyCollectorPolicy(tab, batches);
  const map = kernel.compileEvidenceBatches(profiledBatches, {
    tabId: tab.id,
    pageId: args.pageId || null,
    title: tab.title || '',
    url: tab.url || '',
  });
  map.selectionSource = resolved.source;
  map.frameCount = frameCount;
  map.contentBlocks = larkFragment?.contentBlocks || null;
  map.diagnostics = [...(map.diagnostics || []), ...diagnostics].slice(0, 100);
  universalMapCache.set(map.mapId, { map, createdAt: Date.now(), tabId: tab.id, url: tab.url || '' });
  for (const [key, value] of universalMapCache) if (Date.now() - value.createdAt > 15 * 60 * 1000 || universalMapCache.size > 12) universalMapCache.delete(key);
  return map;
}

async function getUniversalMap(args = {}) {
  if (args.mapId && universalMapCache.has(args.mapId)) return universalMapCache.get(args.mapId).map;
  return buildUniversalMap(args);
}

function invalidateUniversalMapsForTab(tabId) {
  const target = Number(tabId || 0);
  if (!target) return;
  for (const [key, value] of universalMapCache) {
    if (Number(value?.tabId || value?.map?.page?.tabId || 0) === target) universalMapCache.delete(key);
  }
}

function isIncompleteLarkMap(map) {
  return Boolean(map?.page?.tabId && isLarkDocumentUrl(map?.page?.url) && map?.completeness?.complete === false);
}

function normalizeExecuteScriptArg(value) {
  if (value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  try {
    return JSON.parse(JSON.stringify(value, (_key, nested) => nested === undefined ? null : nested));
  } catch {
    return value == null ? null : String(value);
  }
}

function queryFromStableLocator(value) {
  const locator = String(value || '');
  const numbered = locator.match(/document:section\[number=(\d{1,5})\]/);
  if (numbered) return `第${numbered[1]}条`;
  return '';
}

function dynamicLarkQuery(args = {}, node = null) {
  return String(
    args.query
    || node?.title
    || node?.text
    || node?.evidence?.sectionTitle
    || queryFromStableLocator(args.locator || args.id)
    || ''
  ).trim();
}

function dynamicLarkTargetHint(node = null) {
  if (!node) return undefined;
  const sourceId = node.sourceId || node.evidence?.sourceId || null;
  const ordinal = node.evidence?.ordinal ?? node.attributes?.ordinal ?? null;
  if (!sourceId && optionalFiniteNumber(ordinal) === null) return undefined;
  return {
    sourceId: sourceId || undefined,
    ordinal: optionalFiniteNumber(ordinal) ?? undefined,
  };
}

async function locateIncompleteLarkTarget(map, args = {}, node = null) {
  if (!map?.page?.tabId || !isLarkDocumentUrl(map?.page?.url)) return null;
  const query = dynamicLarkQuery(args, node);
  if (!query) return null;
  const requestedNumberMatch = query.match(/(?:第\s*)?(\d{1,5})(?:\s*条|\s*[.、:：-])/)
    || query.match(/document:section\[number=(\d{1,5})\]/);
  const requestedNumber = requestedNumberMatch ? Number(requestedNumberMatch[1]) : null;
  const queryCandidates = [...new Set([
    query,
    ...(Number.isFinite(requestedNumber) ? [`${requestedNumber}.`, `${requestedNumber}、`, `第${requestedNumber}条`, String(requestedNumber)] : []),
  ].filter(Boolean))];
  let lastResult = null;
  for (const candidate of queryCandidates) {
    const response = await toolHandlers.lark_locate({
      tabId: map.page.tabId,
      query: candidate,
      strategy: 'auto',
      documentType: 'rich_doc',
      matchMode: args.caseSensitive === true ? 'exact' : 'contains',
      caseSensitive: args.caseSensitive === true,
      contextBefore: Math.max(2, Math.min(20, Number(args.contextBefore || 5))),
      contextAfter: Math.max(2, Math.min(20, Number(args.contextAfter || 8))),
      maxContextChars: Math.max(1000, Math.min(50000, Number(args.maxContextChars || 16000))),
      maxSteps: Math.max(80, Math.min(1200, Number(args.maxSteps || 500))),
      settleMs: Math.max(30, Math.min(250, Number(args.settleMs || 70))),
      searchFromTop: args.searchFromTop !== false,
      restoreOnNotFound: true,
      stableChecks: 2,
      block: args.block || 'center',
      targetHint: args.targetHint || dynamicLarkTargetHint(node),
    });
    const located = parseToolJson(response);
    lastResult = located || lastResult;
    if (!located?.found) continue;
    if (Number.isFinite(requestedNumber)) {
      const targetText = String(located?.target?.text || '');
      const actualNumber = globalThis.ClaudeUniversalBrowserMapCore?.extractLeadingNumber?.(targetText);
      const explicitChinese = new RegExp(`^\\s*第\\s*${requestedNumber}\\s*条(?:\\s|[.、:：-]|$)`).test(targetText);
      if (Number(actualNumber) !== requestedNumber && !explicitChinese) continue;
    }
    invalidateUniversalMapsForTab(map.page.tabId);
    return { ...located, queryRequested: query, queryUsed: candidate, requestedNumber };
  }
  return lastResult || null;
}

function dynamicLarkLocator(map, located, query = '') {
  const core = globalThis.ClaudeUniversalBrowserMapCore;
  const text = String(located?.target?.text || query || '').trim();
  const number = core?.extractLeadingNumber?.(text) ?? (/^\s*(?:第\s*)?(\d{1,5})(?:\s*条)?(?:[.、:：\s-]|$)/.test(text) ? Number(text.match(/^\s*(?:第\s*)?(\d{1,5})/)?.[1]) : null);
  if (optionalFiniteNumber(number) !== null) return `document:section[number=${optionalFiniteNumber(number)}]`;
  const sourceId = String(located?.target?.sourceId || '').trim();
  const key = sourceId || core?.hashString?.(`${map?.page?.url || ''}|${text}`) || 'dynamic';
  return `document:block[key="${String(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 180)}"]`;
}

function dynamicLarkMatch(map, located, args = {}) {
  const text = String(located?.target?.text || args.query || '').trim();
  const locator = dynamicLarkLocator(map, located, args.query || '');
  const number = globalThis.ClaudeUniversalBrowserMapCore?.extractLeadingNumber?.(text);
  return {
    id: `dyn_${globalThis.ClaudeUniversalBrowserMapCore?.hashString?.(`${locator}|${located?.target?.sourceId || ''}`) || Date.now()}`,
    locator,
    type: optionalFiniteNumber(number) !== null ? 'document_section' : 'document_block',
    role: optionalFiniteNumber(number) !== null ? 'heading' : (located?.target?.role || 'paragraph'),
    title: optionalFiniteNumber(number) !== null ? text : '',
    textPreview: text.slice(0, 500),
    score: 5000,
    confidence: 0.97,
    frameId: Number(located?.selectedFrame?.frameId || 0),
    adapter: 'lark_document_virtual',
    visible: located?.targetVisible === true,
    materialized: located?.targetRendered === true,
    opaque: false,
    bounds: located?.target?.rect ? [located.target.rect.x, located.target.rect.y, located.target.rect.width, located.target.rect.height] : null,
    evidence: {
      source: 'lark_virtual_scroll_seek',
      sourceId: located?.target?.sourceId || null,
      ordinal: located?.target?.ordinal ?? null,
      context: located?.context || [],
      strategyUsed: located?.strategyUsed || null,
      positionStable: located?.positionStable === true,
    },
  };
}

function dynamicLarkReadResult(map, located, args = {}) {
  const match = dynamicLarkMatch(map, located, args);
  const context = Array.isArray(located?.context) ? located.context : [];
  const text = String(located?.target?.text || args.query || '').trim();
  return {
    ok: true,
    mapId: map.mapId,
    target: { id: match.id, locator: match.locator },
    nodes: [{
      id: match.id,
      locator: match.locator,
      type: match.type,
      role: match.role,
      title: match.title,
      text,
      attributes: {
        ordinal: located?.target?.ordinal ?? null,
        sourceId: located?.target?.sourceId || null,
        virtualMaterialization: true,
      },
      bounds: match.bounds,
      visible: match.visible,
      materialized: match.materialized,
      opaque: false,
      actionable: false,
      adapter: match.adapter,
      frameId: match.frameId,
      confidence: match.confidence,
      evidence: match.evidence,
      level: 0,
    }, ...context.slice(0, 40).map((item, index) => ({
      id: `${match.id}_ctx_${index}`,
      locator: `${match.locator}/context[${index + 1}]`,
      type: 'document_block',
      role: 'context',
      title: '',
      text: String(item?.text || ''),
      attributes: { relativeIndex: item?.relativeIndex ?? null },
      bounds: null,
      visible: false,
      materialized: true,
      opaque: false,
      actionable: false,
      adapter: 'lark_document_virtual',
      frameId: match.frameId,
      confidence: 0.9,
      evidence: { source: 'lark_virtual_scroll_context' },
      level: 1,
    }))],
    returnedNodeCount: 1 + context.slice(0, 40).length,
    truncated: false,
    source: map.page,
    completeness: map.completeness,
    recovery: {
      used: true,
      reason: 'lark_source_incomplete',
      strategy: located?.strategyUsed || 'virtual_scroll_seek',
      positionStable: located?.positionStable === true,
    },
  };
}


function optionalFiniteNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
}

function anchorKindForNode(node) {
  const blockType = String(node?.attributes?.blockType || node?.attributes?.sourceBlockType || '').toLowerCase();
  if (node?.type === 'document_block' && /image|figure|diagram/.test(blockType)) return 'image';
  if (node?.type === 'document_block' && /attachment|file/.test(blockType)) return 'attachment';
  if (node?.type === 'document_section' && optionalFiniteNumber(node?.number) !== null) return 'numbered_section';
  return String(node?.type || 'region');
}

function isNavigationAnchor(node) {
  if (!node) return false;
  const kind = anchorKindForNode(node);
  if (kind === 'document_block') return false;
  return new Set([
    'document', 'document_section', 'numbered_section', 'image', 'attachment',
    'application', 'region', 'form', 'control', 'dialog', 'data_field',
    'table', 'table_row', 'table_cell', 'sheet', 'sheet_cell',
    'figma_canvas', 'figma_node', 'canvas_surface', 'canvas_node',
  ]).has(kind);
}

function navigationSnapshotFromMap(map) {
  const core = globalThis.ClaudeUniversalBrowserMapCore;
  const isLark = isLarkDocumentUrl(map?.page?.url);
  const primaryCollectors = new Set((map?.mapCoverage?.evidence?.primaryCollectors || []).map(String));

  // Persist only sparse navigation anchors. The map root is synthesized from
  // the content graph instead of reusing an arbitrary DOM/document node. This
  // prevents application chrome from becoming document:root and keeps the
  // read planner independent from collector-specific root elements.
  const sourceNodes = (map?.nodes || []).filter((node) => {
    if (!isNavigationAnchor(node)) return false;
    const scope = String(node?.scopeHint || node?.attributes?.scopeHint || node?.evidence?.scopeHint || 'unknown');
    return !['chrome', 'navigation', 'decorative'].includes(scope);
  });
  const contentNodes = sourceNodes.filter((node) => anchorKindForNode(node) !== 'document');
  const orderedNodes = [...contentNodes].sort((a, b) => {
    const ao = Number(a?.evidence?.ordinal ?? a?.attributes?.ordinal ?? Number.POSITIVE_INFINITY);
    const bo = Number(b?.evidence?.ordinal ?? b?.attributes?.ordinal ?? Number.POSITIVE_INFINITY);
    return ao - bo || String(a.id).localeCompare(String(b.id));
  });
  const allNumberedNodes = orderedNodes.filter((node) => anchorKindForNode(node) === 'numbered_section');
  // One anchor per ordinal: the shortest label is the section TITLE; longer
  // ones are sub-blocks whose text lives in the content store. Duplicates
  // previously multiplied the document read plan (measured 49 sections for 25
  // ordinals) and made the tail re-seek the same area for minutes.
  const chosenNumberedByOrdinal = new Map();
  for (const node of allNumberedNodes) {
    const ordinalValue = Number(node.number ?? node?.evidence?.ordinal ?? node?.attributes?.ordinal);
    if (!Number.isFinite(ordinalValue)) continue;
    const labelLength = String(node.title || node.text || '').length;
    const current = chosenNumberedByOrdinal.get(ordinalValue);
    if (!current || labelLength < current.labelLength) chosenNumberedByOrdinal.set(ordinalValue, { id: String(node.id), labelLength });
  }
  const isChosenNumbered = (node) => {
    const ordinalValue = Number(node.number ?? node?.evidence?.ordinal ?? node?.attributes?.ordinal);
    if (!Number.isFinite(ordinalValue)) return true;
    const chosen = chosenNumberedByOrdinal.get(ordinalValue);
    return !chosen || chosen.id === String(node.id);
  };
  const numberedNodes = allNumberedNodes.filter(isChosenNumbered);
  const nextOrdinalById = new Map();
  for (let index = 0; index < numberedNodes.length; index += 1) {
    const current = numberedNodes[index];
    const next = numberedNodes[index + 1];
    const nextOrdinal = Number(next?.evidence?.ordinal ?? next?.attributes?.ordinal);
    if (Number.isFinite(nextOrdinal)) nextOrdinalById.set(current.id, nextOrdinal);
  }

  const rootId = `content_root_${core?.hashString?.(map?.page?.url || map?.page?.title || 'page') || 'page'}`;
  const adapterVotes = new Map();
  for (const node of numberedNodes.length ? numberedNodes : orderedNodes) {
    const collector = String(node?.evidence?.primaryCollector || node?.adapter || 'generic_dom');
    const weight = primaryCollectors.has(collector) ? 3 : 1;
    adapterVotes.set(collector, (adapterVotes.get(collector) || 0) + weight);
  }
  const rootAdapter = [...adapterVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    || [...primaryCollectors][0]
    || (isLark ? 'lark_document' : 'generic_dom');

  const anchors = [{
    id: rootId,
    locator: 'document:root',
    kind: 'document',
    label: String(map?.page?.title || 'Page content').replace(/\s+/g, ' ').trim().slice(0, 240),
    ordinal: null,
    parentId: null,
    order: 0,
    adapter: 'universal_read_plan',
    confidence: 1,
    frameId: 0,
    locatorEvidence: {
      primaryId: null,
      sourceId: null,
      blockOrdinal: null,
      domPath: null,
      backendDOMNodeId: null,
      textPrefix: String(map?.page?.title || '').slice(0, 160),
      textHash: core?.hashString?.(String(map?.page?.title || '')) || null,
      relativePosition: 0,
      primaryCollector: rootAdapter,
    },
    range: null,
    flags: { visible: true, materialized: true, opaque: false, actionable: false, hasImages: false, hasTable: false },
    searchText: ['content root', 'document root', rootAdapter],
  }];

  const availableIds = new Set(orderedNodes.map((node) => String(node.id)));
  for (let index = 0; index < orderedNodes.length; index += 1) {
    const node = orderedNodes[index];
    const ordinal = Number(node?.evidence?.ordinal ?? node?.attributes?.ordinal);
    const kind = anchorKindForNode(node);
    if (kind === 'numbered_section' && !isChosenNumbered(node)) continue;
    const labelSource = (() => {
      if (kind === 'table_row') return node.attributes?.rowKey || node.evidence?.rowKey || node.locator || 'table row';
      if (kind === 'table_cell') return node.title || node.attributes?.column || node.locator || 'table cell';
      if (kind === 'data_field') return node.title || node.role || 'data field';
      if (kind === 'control') return node.title || node.attributes?.ariaLabel || node.role || 'control';
      if (kind === 'region' || kind === 'application') return node.title || node.role || kind;
      return node.title || node.text || node.role || kind;
    })();
    const label = String(labelSource).replace(/\s+/g, ' ').trim().slice(0, 240);
    const startOrdinal = Number.isFinite(ordinal) ? ordinal : null;
    const nextOrdinal = nextOrdinalById.get(node.id);
    const originalParentId = node.parentId ? String(node.parentId) : null;
    anchors.push({
      id: String(node.id),
      locator: String(node.locator || node.id),
      kind,
      label,
      ordinal: optionalFiniteNumber(node.number),
      parentId: originalParentId && availableIds.has(originalParentId) ? originalParentId : rootId,
      order: index + 1,
      adapter: String(node.evidence?.primaryCollector || node.adapter || 'generic_dom'),
      confidence: Number(node.confidence ?? 0.8),
      frameId: Number(node.frameId || 0),
      locatorEvidence: {
        primaryId: node.sourceId || node.evidence?.sourceId || null,
        sourceId: node.sourceId || node.evidence?.sourceId || null,
        blockOrdinal: startOrdinal,
        domPath: node.attributes?.domPath || node.locatorEvidence?.domPath || null,
        backendDOMNodeId: node.attributes?.backendDOMNodeId || node.locatorEvidence?.backendDOMNodeId || null,
        textPrefix: label.slice(0, 160),
        textHash: core?.hashString?.(label) || null,
        relativePosition: Array.isArray(node.bounds) && Number.isFinite(Number(node.bounds[1])) ? Number(node.bounds[1]) : null,
        // Scroll-container-absolute pixel offset captured at collection. Lark image/
        // diagram blocks carry no domPath, so on-demand capture seeks to this
        // coordinate to re-mount the virtualized block (see captureLarkImageAnchor).
        virtualTop: Number.isFinite(Number(node.evidence?.virtualTop)) ? Number(node.evidence.virtualTop) : null,
        collector: String(node.evidence?.primaryCollector || node.adapter || 'generic_dom'),
      },
      range: startOrdinal !== null ? {
        startOrdinal,
        endOrdinal: Number.isFinite(nextOrdinal) ? nextOrdinal - 1 : null,
        endRule: Number.isFinite(nextOrdinal) ? 'next_numbered_section' : 'document_end',
      } : null,
      flags: {
        visible: node.visible !== false,
        materialized: node.materialized !== false,
        opaque: node.opaque === true,
        actionable: node.actionable === true,
        hasImages: false,
        hasTable: false,
      },
      searchText: [node.role, node.attributes?.ariaLabel, node.evidence?.sectionTitle, node.evidence?.primaryCollector]
        .filter(Boolean)
        .map((value) => String(value).slice(0, 160)),
    });
  }

  const byId = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  for (const anchor of anchors) {
    const parent = anchor.parentId ? byId.get(anchor.parentId) : null;
    if (anchor.kind === 'image' && parent) parent.flags.hasImages = true;
    if (anchor.kind === 'table' && parent) parent.flags.hasTable = true;
  }
  const rootAnchor = byId.get(rootId);
  if (rootAnchor) {
    rootAnchor.flags.hasImages = anchors.some((anchor) => anchor.kind === 'image');
    rootAnchor.flags.hasTable = anchors.some((anchor) => anchor.kind === 'table');
  }

  const kernelCoverage = map?.mapCoverage || null;
  const incompleteReasons = [...new Set([...(kernelCoverage?.reasons || []), ...(map?.completeness?.reasons || [])])];
  const coverageWarnings = [...new Set([...(kernelCoverage?.warnings || []), ...(map?.completeness?.warnings || [])])];
  if (anchors.length <= 1) incompleteReasons.push('navigation_anchors_empty');
  const coverageStatus = kernelCoverage?.status || (map?.completeness?.complete === true ? 'complete' : 'incomplete');
  const coverageComplete = ['complete', 'complete_with_warnings'].includes(coverageStatus) && anchors.length > 1;
  const adapter = (() => {
    if (map.page?.pageType === 'figma') return 'figma_visual_fallback';
    if (isLark) return 'lark_document';
    if (map.page?.pageType === 'spreadsheet' || map.page?.pageType === 'data_application') return 'virtual_grid';
    if (map.page?.pageType === 'canvas_application') return 'canvas_visual_fallback';
    return 'generic_dom';
  })();
  const capabilities = {
    structure: map.page?.pageType === 'figma' || map.page?.pageType === 'canvas_application' ? 'visual_only' : 'derived',
    text: 'on_demand',
    images: 'on_demand',
    tables: 'on_demand',
    actions: ['scroll_into_view', 'focus', 'click', 'input', 'select', 'submit'],
    revisionDetection: 'unknown',
  };
  const mapCoverage = {
    status: coverageComplete ? (coverageWarnings.length ? 'complete_with_warnings' : 'complete') : 'incomplete',
    evidence: {
      ...(kernelCoverage?.evidence || {}),
      sourceNodeCount: map.nodeCount || map.nodes?.length || 0,
      anchorCount: anchors.length,
      numberedSectionCount: anchors.filter((anchor) => anchor.kind === 'numbered_section').length,
      rootNodeCount: 1,
      frameCount: map.frameCount || 0,
      contentRootAdapter: rootAdapter,
    },
    reasons: incompleteReasons,
    warnings: coverageWarnings,
  };
  const diagnostics = (map.diagnostics || []).slice(0, 12);

  if (!coverageComplete) {
    return {
      ok: false,
      code: 'map_build_incomplete',
      page: map.page,
      adapter,
      capabilities,
      revision: { state: 'unknown' },
      kernel: map?.kernel || null,
      kernelTrace: map?.kernelTrace || null,
      mapCoverage,
      diagnostics,
    };
  }

  return {
    ok: true,
    page: map.page,
    adapter,
    capabilities,
    revision: { state: 'unknown' },
    kernel: map?.kernel || null,
    kernelTrace: map?.kernelTrace || null,
    contentBlocks: Array.isArray(map?.contentBlocks) && map.contentBlocks.length ? map.contentBlocks : null,
    anchors,
    mapCoverage,
    diagnostics,
  };
}
function textFromLarkBlocks(blocks = [], maxChars = 60000) {
  const lines = [];
  let chars = 0;
  for (const block of blocks) {
    const text = String(block?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (chars + text.length + 1 > maxChars) break;
    lines.push(text);
    chars += text.length + 1;
  }
  return { text: lines.join('\n'), blockCount: lines.length, truncated: blocks.length > lines.length };
}

async function readLarkAnchorLive(args) {
  const anchor = args.anchor || {};
  const maxChars = Math.max(500, Math.min(250000, Number(args.maxChars || 60000)));
  if (anchor.kind === 'document') {
    const mapResult = parseToolJson(await toolHandlers.lark_deep_read({ tabId: args.tabId, scope: 'map', refresh: false, maxBlocks: 10000, __requestId: args.__requestId }));
    if (!mapResult?.ok) return mapResult || { ok: false, code: 'lark_document_read_failed' };
    const total = Number(mapResult.blockCount || 0);
    const blocks = [];
    const chunkSize = 200;
    for (let start = 0; start < total && blocks.length < 10000; start += chunkSize) {
      if (isRequestAborted(args.__requestId)) return { ok: false, code: 'request_aborted' };
      const range = parseToolJson(await toolHandlers.lark_deep_read({ tabId: args.tabId, scope: 'range', refresh: false, startOrdinal: start, endOrdinal: Math.min(total - 1, start + chunkSize - 1), maxReturnBlocks: chunkSize, maxBlocks: 10000, __requestId: args.__requestId }));
      if (!range?.ok || !Array.isArray(range.blocks)) return { ok: false, code: range?.code || 'lark_document_range_failed', failedRange: [start, Math.min(total - 1, start + chunkSize - 1)] };
      blocks.push(...range.blocks);
    }
    const compact = textFromLarkBlocks(blocks, maxChars);
    return {
      ok: true,
      mode: 'document_summary_source',
      title: mapResult.title || args.page?.title || '',
      text: compact.text,
      returnedBlockCount: compact.blockCount,
      totalBlockCount: total,
      truncated: compact.truncated,
      readCoverage: compact.truncated ? 'partial' : 'complete',
      sourceScanComplete: mapResult.scan?.complete === true,
    };
  }

  // A single-section read must remain targeted. Do not invoke lark_deep_read
  // range first, because a cold service worker would rebuild the full content
  // snapshot. Use the persisted anchor's sourceId/ordinal as the seek hint.
  const startOrdinal = Number(anchor?.range?.startOrdinal ?? anchor?.locatorEvidence?.blockOrdinal);
  const query = anchor.label || anchor.locatorEvidence?.textPrefix || '';
  const located = parseToolJson(await toolHandlers.lark_locate({
    tabId: args.tabId,
    __requestId: args.__requestId,
    query,
    targetHint: {
      sourceId: anchor.locatorEvidence?.sourceId || undefined,
      ordinal: Number.isFinite(startOrdinal) ? startOrdinal : undefined,
    },
    contextBefore: 0,
    contextAfter: 120,
    maxContextChars: maxChars,
    searchFromTop: false,
    restoreOnNotFound: true,
  }));
  if (!located?.found) return { ok: false, code: located?.code || 'target_not_materialized', detail: located };

  const requestedNumber = Number(anchor.ordinal);
  const context = [located.target, ...(located.context || [])].filter(Boolean);
  const bounded = [];
  for (const item of context) {
    const itemText = String(item?.text || '').trim();
    const itemNumber = globalThis.ClaudeUniversalBrowserMapCore?.extractLeadingNumber?.(itemText);
    if (bounded.length > 0 && Number.isFinite(requestedNumber) && Number.isFinite(Number(itemNumber)) && Number(itemNumber) !== requestedNumber) break;
    bounded.push(item);
  }
  const compact = textFromLarkBlocks(bounded, maxChars);
  return {
    ok: true,
    mode: 'target',
    text: compact.text,
    returnedBlockCount: compact.blockCount,
    truncated: compact.truncated,
    readCoverage: located.positionStable === true && !compact.truncated ? 'best_effort_complete' : 'best_effort',
    recovery: {
      strategy: located.strategyUsed || 'targeted_virtual_seek',
      positionStable: located.positionStable === true,
      fullDocumentScan: false,
    },
  };
}

async function readDomAnchorLive(args) {
  const anchor = args.anchor || {};
  const domPath = anchor.locatorEvidence?.domPath;
  if (!domPath) {
    return { ok: false, code: anchor.flags?.opaque ? 'adapter_capability_insufficient' : 'stale_locator', capability: anchor.flags?.opaque ? 'visual_only' : 'dom_path_missing' };
  }
  const frameId = Number(anchor.frameId || 0);
  const maxChars = Math.max(500, Math.min(250000, Number(args.maxChars || 60000)));
  const execution = await chrome.scripting.executeScript({
    target: { tabId: Number(args.tabId), frameIds: [frameId] },
    world: 'MAIN',
    func: (path, kind, limit, expectedOrdinal) => {
      const normalize = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      const leadingNumber = (value) => {
        const text = normalize(value);
        const match = text.match(/^\s*(?:第\s*)?[（(]?\s*(\d{1,5})\s*[）)]?\s*(?:条|[.、:：)）\-]|\s)/);
        return match ? Number(match[1]) : null;
      };
      const resolvePath = (value) => {
        const groups = String(value || '').split(/\s*>>>\s*/);
        let root = document;
        let found = null;
        for (let index = 0; index < groups.length; index += 1) {
          try { found = root.querySelector(groups[index]); } catch { return null; }
          if (!found) return null;
          if (index < groups.length - 1) root = found.shadowRoot;
        }
        return found;
      };
      const node = resolvePath(path);
      if (!node) return { ok: false, code: 'dom_target_not_materialized' };
      let text = '';
      if (kind === 'document_section' || kind === 'numbered_section') {
        const first = normalize(node.innerText || node.textContent || '');
        const currentNumber = Number.isFinite(Number(expectedOrdinal)) ? Number(expectedOrdinal) : leadingNumber(first);
        const pieces = [first];
        const tag = String(node.tagName || '').toLowerCase();
        const headingLevel = /^h[1-6]$/.test(tag) ? Number(tag.slice(1)) : null;
        let sibling = node.nextElementSibling;
        while (sibling && pieces.join('\n').length < limit) {
          const siblingTag = String(sibling.tagName || '').toLowerCase();
          const siblingText = normalize(sibling.innerText || sibling.textContent || '');
          const siblingNumber = leadingNumber(siblingText);
          if (headingLevel && /^h[1-6]$/.test(siblingTag) && Number(siblingTag.slice(1)) <= headingLevel) break;
          if (pieces.length > 0 && currentNumber !== null && siblingNumber !== null && siblingNumber !== currentNumber) break;
          if (siblingText) pieces.push(siblingText);
          sibling = sibling.nextElementSibling;
        }
        text = pieces.join('\n');
      } else {
        text = normalize(node.innerText || node.textContent || '');
      }
      text = normalize(text);
      return { ok: true, text: text.slice(0, limit), truncated: text.length > limit, htmlTag: String(node.tagName || '').toLowerCase() };
    },
    args: [domPath, anchor.kind, maxChars, anchor.ordinal ?? null],
  });
  return execution?.[0]?.result || { ok: false, code: 'read_no_result' };
}

function compactSectionRead(anchor, result) {
  const text = String(result?.text || '').trim();
  return {
    id: anchor.id,
    locator: anchor.locator,
    ordinal: anchor.ordinal ?? null,
    label: anchor.label || '',
    adapter: anchor.adapter || 'unknown',
    ok: result?.ok === true && Boolean(text),
    text,
    truncated: result?.truncated === true,
    readCoverage: result?.readCoverage || (result?.ok ? 'best_effort' : 'failed'),
    code: result?.ok ? null : (result?.code || 'section_read_failed'),
  };
}

async function readOneAnchorLive(args, anchor) {
  const adapter = String(anchor?.adapter || args.adapter || 'generic_dom');
  const routed = { ...args, anchor, adapter, mode: 'target' };
  let result = adapter.startsWith('lark')
    ? await readLarkAnchorLive(routed)
    : await readDomAnchorLive(routed);

  // On Lark pages, sparse anchors may originate from the generic DOM collector
  // while the node is virtualized later. Fall back to the Lark materializer for
  // that one target only; do not rebuild the map or rescan completed sections.
  if (!result?.ok && isLarkDocumentUrl(args?.page?.url) && !adapter.startsWith('lark')) {
    result = await readLarkAnchorLive({ ...routed, adapter: 'lark_document' });
  }
  return result;
}

async function readDocumentPlanLive(args) {
  const plan = Array.isArray(args?.readPlan?.sections) ? args.readPlan.sections : [];
  const maxChars = Math.max(1000, Math.min(250000, Number(args.maxChars || 120000)));
  if (!plan.length) {
    const fallbackAdapter = String(args?.anchor?.locatorEvidence?.primaryCollector || args.adapter || 'generic_dom');
    return fallbackAdapter.startsWith('lark')
      ? readLarkAnchorLive({ ...args, adapter: fallbackAdapter, anchor: { ...(args.anchor || {}), kind: 'document' } })
      : readDomAnchorLive({ ...args, adapter: fallbackAdapter });
  }

  const sections = [];
  const failures = [];
  let usedChars = 0;
  const planRequestId = args.__requestId || null;
  let planIndex = 0;
  for (const anchor of plan) {
    // The guard declared this request terminal: stop working for it NOW
    // instead of scrolling the page as a zombie.
    if (isRequestAborted(planRequestId)) {
      failures.push({ id: anchor.id, ordinal: anchor.ordinal ?? null, label: anchor.label || '', code: 'request_aborted' });
      break;
    }
    planIndex += 1;
    // Genuine per-section progress: keeps the host idle timeout honest during
    // long sequential plans (the 600s hard deadline still caps the total).
    sendProgress(planRequestId, 'read_plan_section', { index: planIndex, total: plan.length, ordinal: anchor.ordinal ?? null });
    if (usedChars >= maxChars) {
      failures.push({ id: anchor.id, ordinal: anchor.ordinal ?? null, label: anchor.label || '', code: 'task_char_budget_exhausted' });
      continue;
    }
    const remaining = Math.max(500, maxChars - usedChars);
    const perSectionLimit = Math.max(1000, Math.min(30000, remaining));
    const result = await readOneAnchorLive({ ...args, maxChars: perSectionLimit }, anchor);
    const compact = compactSectionRead(anchor, result);
    if (compact.ok) {
      if (compact.text.length > remaining) {
        compact.text = compact.text.slice(0, remaining);
        compact.truncated = true;
      }
      usedChars += compact.text.length + 2;
      sections.push(compact);
    } else {
      failures.push({ id: anchor.id, ordinal: anchor.ordinal ?? null, label: anchor.label || '', adapter: anchor.adapter || null, code: compact.code });
    }
  }

  const combined = sections.map((section) => {
    const heading = section.ordinal != null ? `【第${section.ordinal}条】 ${section.label}` : section.label;
    return `${heading}\n${section.text}`.trim();
  }).join('\n\n');
  const complete = failures.length === 0 && sections.length === plan.length;
  return {
    ok: complete,
    code: complete ? null : 'document_read_plan_incomplete',
    terminal: !complete,
    doNotRetryWithMoreToolCalls: !complete,
    mode: 'document_summary_source',
    title: args?.page?.title || '',
    text: combined,
    sections,
    plannedSectionCount: plan.length,
    returnedSectionCount: sections.length,
    failedSections: failures,
    truncated: usedChars >= maxChars || sections.some((section) => section.truncated),
    readCoverage: complete ? 'complete' : 'partial',
    mapWasRebuilt: false,
    parallelReadsUsed: false,
    readStrategy: 'single_internal_sequential_plan',
  };
}
async function actOnAnchorLive(args) {
  const anchor = args.anchor || {};
  const action = String(args.action || 'scroll_into_view');
  if (String(args.adapter || '').startsWith('lark') && !anchor.locatorEvidence?.domPath) {
    const located = parseToolJson(await toolHandlers.lark_locate({
      tabId: args.tabId,
      __requestId: args.__requestId,
      query: anchor.label || anchor.locatorEvidence?.textPrefix || '',
      targetHint: {
        sourceId: anchor.locatorEvidence?.sourceId || undefined,
        ordinal: anchor.locatorEvidence?.blockOrdinal ?? undefined,
      },
      contextBefore: 0,
      contextAfter: 2,
      searchFromTop: false,
      restoreOnNotFound: true,
      block: 'center',
    }));
    if (!located?.found) return { ok: false, code: located?.code || 'target_not_materialized' };
    if (['scroll_into_view', 'focus'].includes(action)) return { ok: true, action, materialized: true, target: located.target };
    return { ok: false, code: 'adapter_capability_insufficient', action, adapter: args.adapter };
  }
  const domPath = anchor.locatorEvidence?.domPath;
  if (!domPath) return { ok: false, code: anchor.flags?.opaque ? 'opaque_surface_not_directly_actionable' : 'stale_locator' };
  const execution = await chrome.scripting.executeScript({
    target: { tabId: Number(args.tabId), frameIds: [Number(anchor.frameId || 0)] },
    world: 'MAIN',
    func: (path, actionName, value) => {
      const groups = String(path || '').split(/\s*>>>\s*/);
      let root = document;
      let element = null;
      for (let index = 0; index < groups.length; index += 1) {
        try { element = root.querySelector(groups[index]); } catch { return { ok: false, code: 'invalid_dom_path' }; }
        if (!element) return { ok: false, code: 'dom_target_not_materialized' };
        if (index < groups.length - 1) root = element.shadowRoot;
      }
      if (actionName === 'scroll_into_view') { element.scrollIntoView({ block: 'center', inline: 'nearest' }); return { ok: true }; }
      if (actionName === 'focus') { element.focus(); return { ok: true }; }
      if (actionName === 'click' || actionName === 'submit') { element.click(); return { ok: true }; }
      if (actionName === 'input') {
        if (!('value' in element)) return { ok: false, code: 'target_not_input' };
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
        if (setter) setter.call(element, value); else element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      }
      if (actionName === 'select') {
        if (!('value' in element)) return { ok: false, code: 'target_not_select' };
        element.value = value;
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      }
      return { ok: false, code: 'unsupported_action', action: actionName };
    },
    args: [domPath, action, args.value ?? null],
  });
  return execution?.[0]?.result || { ok: false, code: 'action_no_result' };
}

// —— /figma-ws:抓当前 Figma tab 的 WS fig-kiwi 帧(全自动) ——
// 有常驻抓帧脚本且大帧已到 → 直接 grab(不刷新);否则 reload 该 tab 抢初始全量帧 + 轮询等大帧。
const FIGMA_WS_DATA_THRESHOLD = 50000; // 全量场景图数据帧通常 >>50KB;小于此视作大帧未到
async function figmaWsStatus(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => (window.__figCaptureStatus ? window.__figCaptureStatus() : null) });
    return r?.result || null;
  } catch { return null; } // 导航中/无 frame 时会抛,轮询重试即可
}
async function figmaWsGrab(tabId) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => (window.__figCaptureGrab ? window.__figCaptureGrab() : null) });
  return r?.result || null;
}
// 落盘抓帧:页面把帧原生写盘(二进制),扩展经 chrome.downloads 拿绝对路径交 host 读。
// 避免 39MB 帧经 executeScript 返回 → 原生消息 → TCP 多趟序列化卡死(曾 240s 超时)。
async function figmaWsGrabToDisk(tabId, requestId) {
  const token = `${Date.now()}-${tabId}`; // 唯一,供 downloads.search 精确匹配本次文件
  const basename = `figma-ws-frames-${token}.bin`;
  const [r] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: (bn) => (window.__figCaptureGrabToDisk ? window.__figCaptureGrabToDisk(bn) : null),
    args: [basename],
  });
  const meta = r?.result || null;
  // meta 为 null = 页面里没有 __figCaptureGrabToDisk(常驻脚本是旧版:扩展刚更新、该 tab 未换新内容脚本)。
  // 交调用方 reload 换新脚本重试,别当"没帧"误报。meta 存在但 ok=false 才是真的抓帧失败。
  if (!meta) return { stale: true };
  if (!meta.ok) throw new Error('落盘抓帧失败(页面未产生场景图数据帧;刷新后重试)');
  // 轮询下载记录拿绝对路径(不假设 Downloads 目录 —— 用户可能改过下载位置)。
  const deadline = Date.now() + 60000;
  let item = null;
  while (Date.now() < deadline) {
    await sleep(400);
    sendProgress(requestId, 'figma_ws_downloading', { bytes: meta.bytes || 0 });
    let found = [];
    try { found = await chrome.downloads.search({ query: [token] }); } catch {}
    const bad = found.find((d) => d.state === 'interrupted');
    if (bad) throw new Error(`帧文件下载中断(${bad.error || 'interrupted'})`);
    const done = found.find((d) => d.state === 'complete' && d.filename);
    if (done) { item = done; break; }
  }
  if (!item) throw new Error('帧文件落盘超时(60s);若浏览器开了"每次下载前询问保存位置"请关闭后重试');
  try { await chrome.downloads.erase({ id: item.id }); } catch {} // 清下载记录/角标,文件留给 host 读完再删
  return { framePath: item.filename, meta };
}
async function captureFigmaWsFrames(args = {}) {
  const tab = await getTab(args.tabId ? Number(args.tabId) : null);
  if (!tab?.id) throw new Error('找不到目标标签页');
  if (!/figma\.com/i.test(String(tab.url || ''))) throw new Error(`当前标签页不是 Figma 页(${tab.url || ''})`);
  const tabId = tab.id;
  const requestId = args.__requestId || null;
  const ready = (s) => Boolean(s && s.schema >= 1 && s.dataMax >= FIGMA_WS_DATA_THRESHOLD);

  // 不自动刷新页面(会打断用户 + 抓帧中途 reload 可能扰动浏览器桥)。只查一次:
  // 未就绪(无常驻脚本 / 大帧未到)→ 提示用户手动刷新;就绪则落盘抓帧。
  const status = await figmaWsStatus(tabId);
  if (!ready(status)) {
    return { ok: false, needsRefresh: true, reason: status ? 'frames_not_ready' : 'no_script', dataMaxMb: ((status?.dataMax || 0) / 1e6).toFixed(1) };
  }
  // 帧原生写盘,只把绝对路径(几十字节)带回 host —— 大帧不再经 executeScript/原生消息搬运。
  const grab = await figmaWsGrabToDisk(tabId, requestId);
  // 常驻脚本是旧版(扩展刚更新、该 tab 还挂旧内容脚本,无 __figCaptureGrabToDisk)→ 同样提示手动刷新换新脚本。
  if (grab?.stale) return { ok: false, needsRefresh: true, reason: 'stale_script', dataMaxMb: ((status?.dataMax || 0) / 1e6).toFixed(1) };
  if (!grab?.framePath) throw new Error('未抓到 WS 帧(该 Figma 页未产生场景图数据帧;刷新页面后重试)');
  return { ok: true, framePath: grab.framePath, meta: grab.meta, status, tabUrl: tab.url };
}

const toolHandlers = {
  async __pure_map_figma_ws_capture(args) {
    const result = await captureFigmaWsFrames(args || {});
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }; // bundle 大,不 pretty-print
  },

  async __pure_map_build_navigation_map(args) {
    const map = await buildUniversalMap({ ...(args || {}), refresh: args?.refresh === true });
    // Always return a compact navigation snapshot. Returning the raw Universal
    // Map on failure previously leaked hundreds of kilobytes into model context.
    const snapshot = map?.nodes
      ? navigationSnapshotFromMap(map)
      : {
          ok: false,
          code: map?.code || 'map_build_failed',
          page: map?.page || null,
          mapCoverage: map?.mapCoverage || { status: 'incomplete', reasons: [map?.code || 'map_build_failed'] },
          diagnostics: Array.isArray(map?.diagnostics) ? map.diagnostics.slice(0, 8) : [],
        };
    if (map?.mapId) universalMapCache.delete(map.mapId);
    return { content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }] };
  },

  async __pure_map_read_target(args) {
    const adapter = String(args?.adapter || '');
    // Image anchors are captured as pixels regardless of adapter (the host turns
    // the returned base64 into a native image block for the model).
    const result = args?.anchor?.kind === 'image'
      ? await captureImageAnchor(args?.tabId, args?.anchor || {}, args?.__requestId, Number(args?.totalBlockCount ?? args?.blockCount ?? args?.mapBlockCount) || null)
      : args?.anchor?.kind === 'document' && Array.isArray(args?.readPlan?.sections)
        ? await readDocumentPlanLive(args || {})
        : adapter.startsWith('lark')
          ? await readLarkAnchorLive(args || {})
          : await readDomAnchorLive(args || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },

  async __pure_map_act_target(args) {
    const result = await actOnAnchorLive(args || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },

  async browser_map(args) {
    const map = await buildUniversalMap(args || {});
    if (!map?.ok) return { content: [{ type: 'text', text: JSON.stringify(map, null, 2) }] };
    const includeNodes = args?.includeNodes === true;
    const maxReturnNodes = Math.max(1, Math.min(2000, Number(args?.maxReturnNodes || 200)));
    const result = includeNodes ? { ...map, nodes: map.nodes.slice(0, maxReturnNodes), nodesTruncated: map.nodes.length > maxReturnNodes } : {
      ok: true,
      schemaVersion: map.schemaVersion,
      mapId: map.mapId,
      createdAt: map.createdAt,
      page: map.page,
      pageType: map.page?.pageType,
      nodeCount: map.nodeCount,
      rootNodeIds: map.rootNodeIds,
      capabilities: map.capabilities,
      completeness: map.completeness,
      frameCount: map.frameCount,
      selectionSource: map.selectionSource,
      diagnostics: map.diagnostics,
      nodeTypeCounts: Object.fromEntries([...new Set(map.nodes.map((node) => node.type))].map((type) => [type, map.nodes.filter((node) => node.type === type).length])),
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },

  async browser_locate(args) {
    let map = await getUniversalMap(args || {});
    if (!map?.ok) return { content: [{ type: 'text', text: JSON.stringify(map, null, 2) }] };
    let result = globalThis.ClaudeUniversalBrowserMapCore.locate(map, args.query || args.locator || args.id || '', args || {});
    if (!result.found && args?.query && isIncompleteLarkMap(map)) {
      const located = await locateIncompleteLarkTarget(map, args || {});
      if (located?.found) {
        const refreshed = await buildUniversalMap({ ...(args || {}), tabId: map.page.tabId, refresh: true });
        if (refreshed?.ok) {
          map = refreshed;
          result = globalThis.ClaudeUniversalBrowserMapCore.locate(map, args.query || '', args || {});
        }
        if (!result.found) {
          const match = dynamicLarkMatch(map, located, args || {});
          result = {
            ok: true,
            found: true,
            query: String(args.query || ''),
            mapId: map.mapId,
            matches: [match],
            completeness: map.completeness,
            recovery: {
              used: true,
              reason: 'lark_source_incomplete',
              strategy: located.strategyUsed || 'virtual_scroll_seek',
              positionStable: located.positionStable === true,
            },
          };
        } else {
          result.recovery = {
            used: true,
            reason: 'lark_source_incomplete',
            strategy: located.strategyUsed || 'virtual_scroll_seek',
            positionStable: located.positionStable === true,
          };
          result.completeness = map.completeness;
        }
      } else if (located) {
        result.recovery = { used: true, found: false, code: located.code || 'virtual_scroll_seek_incomplete' };
        result.completeness = map.completeness;
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },

  async browser_read(args) {
    let map = await getUniversalMap(args || {});
    if (!map?.ok) return { content: [{ type: 'text', text: JSON.stringify(map, null, 2) }] };
    let target = args.locator || args.id;
    if (!target && args.query) {
      const located = globalThis.ClaudeUniversalBrowserMapCore.locate(map, args.query, { ...args, limit: 1 });
      target = located.matches?.[0]?.locator || located.matches?.[0]?.id;
      if (!target && isIncompleteLarkMap(map)) {
        const dynamic = await locateIncompleteLarkTarget(map, args || {});
        if (dynamic?.found) {
          const refreshed = await buildUniversalMap({ ...(args || {}), tabId: map.page.tabId, refresh: true });
          if (refreshed?.ok) {
            map = refreshed;
            const retry = globalThis.ClaudeUniversalBrowserMapCore.locate(map, args.query, { ...args, limit: 1 });
            target = retry.matches?.[0]?.locator || retry.matches?.[0]?.id;
          }
          if (!target) {
            return { content: [{ type: 'text', text: JSON.stringify(dynamicLarkReadResult(map, dynamic, args || {}), null, 2) }] };
          }
        }
      }
    }
    let result = globalThis.ClaudeUniversalBrowserMapCore.read(map, target, args || {});
    if (!result?.ok && isIncompleteLarkMap(map)) {
      const node = globalThis.ClaudeUniversalBrowserMapCore.resolveNode(map, target);
      const dynamic = await locateIncompleteLarkTarget(map, { ...(args || {}), query: dynamicLarkQuery({ ...(args || {}), locator: args.locator || target, id: args.id }, node) || String(target || '') }, node);
      if (dynamic?.found) result = dynamicLarkReadResult(map, dynamic, args || {});
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },

  async browser_act(args) {
    let map = await getUniversalMap(args || {});
    if (!map?.ok) return { content: [{ type: 'text', text: JSON.stringify(map, null, 2) }] };
    let node = globalThis.ClaudeUniversalBrowserMapCore.resolveNode(map, args.locator || args.id);
    if (!node && args.query) {
      const located = globalThis.ClaudeUniversalBrowserMapCore.locate(map, args.query, { ...args, limit: 1 });
      node = globalThis.ClaudeUniversalBrowserMapCore.resolveNode(map, located.matches?.[0]?.locator || located.matches?.[0]?.id);
    }
    const action = String(args.action || 'scroll_into_view');
    if (!node && isIncompleteLarkMap(map) && dynamicLarkQuery(args || {})) {
      const dynamic = await locateIncompleteLarkTarget(map, { ...(args || {}), query: dynamicLarkQuery(args || {}) });
      if (dynamic?.found && ['scroll_into_view','focus'].includes(action)) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, code: 'lark_virtual_target_materialized', action, mapId: map.mapId, locator: dynamicLarkLocator(map, dynamic, args.query || ''), page: map.page, target: dynamic.target, recovery: { used: true, strategy: dynamic.strategyUsed || 'virtual_scroll_seek', positionStable: dynamic.positionStable === true } }, null, 2) }] };
      }
    }
    if (!node) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'locator_not_found', mapId: map.mapId }, null, 2) }] };
    if (['click','input','select','submit'].includes(action) && args.confirmed !== true) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'action_confirmation_required', action, locator: node.locator, preview: { title: node.title, text: node.text, page: map.page } }, null, 2) }] };
    }
    if (['scroll_into_view','focus'].includes(action) && isLarkDocumentUrl(map.page?.url) && node.adapter === 'lark_document' && !node.attributes?.domPath) {
      const dynamic = await locateIncompleteLarkTarget(map, { ...(args || {}), query: dynamicLarkQuery(args, node), restoreOnNotFound: true }, node);
      if (dynamic?.found) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, code: 'lark_virtual_target_materialized', action, mapId: map.mapId, locator: node.locator, page: map.page, target: dynamic.target, recovery: { used: true, strategy: dynamic.strategyUsed || 'virtual_scroll_seek', positionStable: dynamic.positionStable === true } }, null, 2) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, code: dynamic?.code || 'lark_virtual_target_not_found', action, mapId: map.mapId, locator: node.locator, page: map.page, retryable: true }, null, 2) }] };
    }
    if (node.opaque && !node.attributes?.domPath) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'opaque_surface_not_directly_actionable', locator: node.locator, adapter: node.adapter }, null, 2) }] };
    const frameId = Number(node.frameId || 0);
    const scriptArgs = [
      normalizeExecuteScriptArg(node.attributes?.domPath || ''),
      normalizeExecuteScriptArg(action),
      normalizeExecuteScriptArg(args.value),
    ];
    const execution = await chrome.scripting.executeScript({
      target: { tabId: map.page.tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: (domPath, actionName, value) => {
        const resolvePath = (path) => {
          const groups = String(path || '').split(/\s*>>>\s*/);
          let root = document;
          let found = null;
          for (let index = 0; index < groups.length; index += 1) {
            try { found = root.querySelector(groups[index]); } catch { return null; }
            if (!found) return null;
            if (index < groups.length - 1) root = found.shadowRoot;
          }
          return found;
        };
        const element = resolvePath(domPath);
        if (!element) return { ok: false, code: 'dom_target_not_materialized' };
        if (actionName === 'scroll_into_view') { element.scrollIntoView({ block: 'center', inline: 'nearest' }); return { ok: true }; }
        if (actionName === 'focus') { element.focus(); return { ok: true }; }
        if (actionName === 'click') { element.click(); return { ok: true }; }
        if (actionName === 'input') {
          if (!('value' in element)) return { ok: false, code: 'target_not_input' };
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
          if (setter) setter.call(element, value); else element.value = value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        }
        return { ok: false, code: 'unsupported_action', action: actionName };
      },
      args: scriptArgs,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ ...(execution?.[0]?.result || { ok: false, code: 'action_no_result' }), mapId: map.mapId, locator: node.locator, page: map.page }, null, 2) }] };
  },

  // Private host-to-extension route. It is not part of the model-visible MCP surface.
  async __pure_map_page_context(args) {
    const runtime = globalThis.__claudeSidebarBrowserTaskRuntime;
    const result = runtime
      ? await runtime.handlePageContextAction(args || {})
      : { ok: false, code: "browser_task_runtime_missing" };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },

  // Compatibility routes for older MCP runtimes that forward these names directly.
  async lark_session(args) {
    const action = String(args?.action || args?.mode || 'start').toLowerCase();
    if (action === 'status' || action === 'inspect') return toolHandlers.lark_browser_session_status(args || {});
    return toolHandlers.lark_deep_read({ ...(args || {}), scope: 'map', refresh: action !== 'history' });
  },
  async lark_session_start(args) {
    return toolHandlers.lark_session({ ...(args || {}), action: args?.mode === 'history' ? 'history' : 'start' });
  },
  async lark_index_refresh(args) {
    return toolHandlers.lark_deep_read({ ...(args || {}), scope: 'map', refresh: true });
  },
  async lark_read(args) {
    const mode = String(args?.mode || 'summary');
    if (mode !== 'summary') {
      return toolHandlers.lark_deep_read({ ...(args || {}), scope: mode === 'search' ? 'search' : 'range', query: args?.question || args?.query });
    }
    const mapResponse = await toolHandlers.lark_deep_read({ ...(args || {}), scope: 'map', refresh: args?.refresh === true });
    let map;
    try { map = JSON.parse(mapResponse?.content?.[0]?.text || '{}'); } catch { map = null; }
    if (!map?.ok || !Number.isFinite(Number(map.blockCount))) return mapResponse;
    const blockCount = Number(map.blockCount || 0);
    const chunkSize = Math.max(50, Math.min(250, Number(args?.chunkSize || 200)));
    const maxChars = Math.max(10000, Math.min(300000, Number(args?.maxChars || 160000)));
    const blocks = [];
    let chars = 0;
    for (let startOrdinal = 0; startOrdinal < blockCount && chars < maxChars; startOrdinal += chunkSize) {
      const rangeResponse = await toolHandlers.lark_deep_read({ ...(args || {}), scope: 'range', refresh: false, startOrdinal, endOrdinal: Math.min(blockCount - 1, startOrdinal + chunkSize - 1), maxReturnBlocks: chunkSize });
      let range;
      try { range = JSON.parse(rangeResponse?.content?.[0]?.text || '{}'); } catch { range = null; }
      if (!range?.ok || !Array.isArray(range.blocks)) return rangeResponse;
      for (const block of range.blocks) {
        const text = String(block?.text || '');
        if (chars + text.length > maxChars) break;
        blocks.push(block);
        chars += text.length;
      }
    }
    const result = {
      ok: true,
      mode: 'summary',
      backend: 'browser_session',
      compatibilityRoute: true,
      title: map.title || '',
      url: map.url || '',
      blockCount,
      returnedBlockCount: blocks.length,
      sourceComplete: map.scan?.complete === true && blocks.length === blockCount,
      coverage: { complete: map.scan?.complete === true && blocks.length === blockCount },
      sections: map.sections || [],
      blocks,
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },

  // CLAUDE_SIDEBAR_V67_DOCUMENT_SESSION_HANDLER
  async lark_document_identity(args) {
    const resolved = await resolveLarkDocumentTab(args || {});
    if (!resolved.ok) return { content: [{ type: "text", text: JSON.stringify(resolved, null, 2) }] };
    const tab = resolved.tab;
    const tabId = tab.id;
    return { content: [{ type: "text", text: JSON.stringify({
      ok: true,
      tabId,
      title: tab.title || "Untitled",
      url: tab.url || "",
      backend: "browser_session",
      readOnly: true,
      selectionReason: resolved.selectionReason,
      alternatives: resolved.alternatives || []
    }, null, 2) }] };
  },

  async lark_browser_session_status(args) {
    const resolved = await resolveLarkDocumentTab(args || {});
    if (!resolved.ok) return { content: [{ type: 'text', text: JSON.stringify({ ...resolved, backend: 'browser_session' }, null, 2) }] };
    const tab = resolved.tab;
    const diagnostics = [];
    try {
      const injection = await injectLarkFrameRuntime(tab.id);
      diagnostics.push(...injection.filter((item) => !item.ok).map((item) => ({ stage: 'inject', ...item })));
      const [sessions, probes] = await Promise.all([
        discoverStoredLarkFrameSessions(tab.id, injection).catch((error) => { diagnostics.push({ stage: 'sessions', code: error?.code || null, error: String(error?.message || error) }); return []; }),
        probeLarkFrames(tab.id, injection).catch((error) => { diagnostics.push({ stage: 'probes', code: error?.code || null, error: String(error?.message || error) }); return []; }),
      ]);
      const cachePrefix = `${tab.id}:`;
      const caches = [...larkDeepReadCache.entries()].filter(([key]) => key.startsWith(cachePrefix)).map(([key, value]) => ({ key, ageMs: Date.now() - value.createdAt, maxBlocks: value.maxBlocks, blockCount: value.documentMap?.blockCount || 0, complete: value.documentMap?.scan?.complete === true, frameId: value.frameId || null, sessionId: value.sessionId || null }));
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        backend: 'browser_session',
        protocol: 'universal-browser-map-v3',
        extensionVersion: '0.15.3',
        extensionProtocolVersion: 14,
        extensionBootId: EXTENSION_BOOT_ID,
        lastNativeDisconnectError,
        tabId: tab.id,
        title: tab.title || '',
        url: tab.url || '',
        selectionReason: resolved.selectionReason,
        nativePortConnected: Boolean(nativePort),
        queuedNativeMessages: nativeOutboundQueue.length,
        inflightToolRequests: inflightToolRequests.size,
        serviceWorkerCaches: caches,
        pageResidentSessions: sessions.slice(0, 10),
        frameProbes: probes.slice(0, 10),
        diagnostics,
      }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, code: error?.code || 'browser_session_status_failed', error: String(error?.message || error), tabId: tab.id, frameInjection: error?.frameInjection || null, diagnostics, runtime: { extensionVersion: '0.15.3', protocolVersion: 13, bootId: EXTENSION_BOOT_ID, nativePortConnected: Boolean(nativePort), lastNativeDisconnectError } }, null, 2) }] };
    }
  },

  async lark_deep_read(args) {
    const resolved = await resolveLarkDocumentTab(args || {});
    if (!resolved.ok) return { content: [{ type: 'text', text: JSON.stringify({ ...resolved, backend: 'browser_session', readOnly: true }, null, 2) }] };
    const selectedTab = resolved.tab;
    const tabId = selectedTab.id;
    const requestId = args.__requestId;
    const publicArgs = { ...args };
    delete publicArgs.__requestId;

    const core = globalThis.OpenClaudeLarkReaderCore;
    if (!core?.buildDocumentMap || !core?.executeRead) throw new Error('Lark reader core was not loaded in the extension service worker');

    const cacheKey = `${tabId}:${selectedTab.url || ''}`;
    const cached = larkDeepReadCache.get(cacheKey);
    const cacheAgeMs = cached ? Date.now() - cached.createdAt : Number.POSITIVE_INFINITY;
    const requestedMaxBlocks = Number(publicArgs.maxBlocks || 5000);
    const cacheUsable = !publicArgs.refresh && cached && cacheAgeMs < 15 * 60 * 1000
      && cached.maxBlocks >= requestedMaxBlocks && reusableLarkScan(cached.documentMap?.scan || {});

    let documentMap;
    let cacheHit = false;
    const frameDiagnostics = [];
    if (cacheUsable) {
      documentMap = cached.documentMap;
      cacheHit = true;
      sendProgress(requestId, 'lark_service_worker_cache_hit', { tabId, blockCount: documentMap.blockCount || documentMap.entries?.length || 0 });
    } else {
      const scanOptions = {
        maxBlocks: publicArgs.maxBlocks,
        maxSteps: Math.max(100, Math.min(1800, Number(publicArgs.maxSteps || 1400))),
        settleMs: Math.max(30, Math.min(120, Number(publicArgs.settleMs || 70))),
        maxTargets: publicArgs.maxTargets,
        bottomStableSteps: publicArgs.bottomStableSteps,
        outlineAssist: publicArgs.outlineAssist,
        maxOutlineEntries: publicArgs.maxOutlineEntries,
        requireOutlineCoverage: publicArgs.requireOutlineCoverage,
      };
      try {
        const snapshot = await loadStableLarkFrameSnapshot(tabId, args, scanOptions, frameDiagnostics);
        documentMap = core.buildDocumentMap(snapshot.blocks, {
          title: snapshot.title,
          url: snapshot.url,
          scan: {
            ...snapshot.scan,
            browserSession: {
              protocol: 'universal-browser-map-v3',
        extensionVersion: '0.15.3',
        extensionProtocolVersion: 14,
        extensionBootId: EXTENSION_BOOT_ID,
        lastNativeDisconnectError,
              sessionId: snapshot.sessionId,
              restored: snapshot.restored === true,
              transportAttempts: snapshot.transportAttempts,
              transportChunkSize: Math.max(50, Math.min(250, Number(publicArgs.transportChunkSize || 200))),
            },
            selectedFrame: {
              frameId: snapshot.frameId,
              documentId: snapshot.documentId || null,
              url: snapshot.url || null,
              title: snapshot.title || null,
            },
            frameDiagnostics: frameDiagnostics.slice(0, 40),
          },
        });
        larkDeepReadCache.set(cacheKey, { createdAt: Date.now(), maxBlocks: requestedMaxBlocks, documentMap, frameId: snapshot.frameId, sessionId: snapshot.sessionId });
        for (const [key, value] of larkDeepReadCache) {
          if (Date.now() - value.createdAt > 15 * 60 * 1000 || (!key.startsWith(`${tabId}:`) && larkDeepReadCache.size > 6)) larkDeepReadCache.delete(key);
        }
      } catch (error) {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false,
          code: error?.code || 'browser_session_recovery_exhausted',
          error: String(error?.message || error),
          tabId,
          backend: 'browser_session',
          readOnly: true,
          retryable: true,
          recoveryAttempted: true,
          fallbackRecommended: false,
          frameDiagnostics: frameDiagnostics.slice(0, 80),
          runtime: { extensionVersion: '0.15.3', protocolVersion: 13, bootId: EXTENSION_BOOT_ID, nativePortConnected: Boolean(nativePort), lastNativeDisconnectError },
        }, null, 2) }] };
      }
    }

    const safeArgs = { ...publicArgs };
    if (safeArgs.scope === 'range' || safeArgs.scope === 'search' || safeArgs.scope === 'section') {
      safeArgs.maxReturnBlocks = Math.max(1, Math.min(250, Number(safeArgs.maxReturnBlocks || 200)));
    }
    const result = core.executeRead(documentMap, safeArgs);
    return { content: [{ type: 'text', text: JSON.stringify({
      ...result,
      cacheHit,
      cacheAgeMs: cacheHit ? cacheAgeMs : 0,
      frameDiagnostics: cacheHit ? undefined : frameDiagnostics.slice(0, 40),
      backend: 'browser_session',
      browserSessionProtocol: 'universal-browser-map-v3',
      readOnly: true,
    }, null, 2) }] };
  },

  async lark_locate(args) {
    const resolved = await resolveLarkDocumentTab(args || {});
    if (!resolved.ok) return { content: [{ type: "text", text: JSON.stringify({ ...resolved, found: false, backend: "browser_session", readOnly: true }, null, 2) }] };
    const selectedTab = resolved.tab;
    const tabId = selectedTab.id;

    const locateOptions = {
      query: args.query,
      strategy: args.strategy,
      documentType: args.documentType,
      matchMode: args.matchMode,
      caseSensitive: args.caseSensitive,
      contextBefore: args.contextBefore,
      contextAfter: args.contextAfter,
      maxContextChars: args.maxContextChars,
      maxSteps: args.maxSteps,
      maxTargets: args.maxTargets,
      settleMs: args.settleMs,
      searchFromTop: args.searchFromTop,
      restoreOnNotFound: args.restoreOnNotFound,
      block: args.block,
      stableChecks: args.stableChecks,
      targetHint: args.targetHint,
    };

    let frameDiagnostics = [];
    let frameResults = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (isRequestAborted(args.__requestId)) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, found: false, code: "request_aborted", backend: "browser_session", readOnly: true }, null, 2) }] };
      }
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: "MAIN",
          files: ["lark-reader-core.js", "virtual-scroll-seek.js", "lark-deep-reader.js"],
        });
        // The in-page seek can legitimately run for minutes on a heavy virtual
        // document; heartbeats keep the caller's idle guard honest meanwhile.
        const executions = await withProgressHeartbeat(args.__requestId, 'lark_locate_seeking', { attempt: attempt + 1, tabId }, () => chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: "MAIN",
          func: async (options) => {
            const runtime = globalThis.OpenClaudeLarkDeepReader;
            if (!runtime?.frameLocate) return { ok: true, found: false, code: "lark_locator_runtime_missing", frameUrl: location.href, frameTitle: document.title };
            try {
              const result = await runtime.frameLocate(options);
              return { ...result, frameUrl: location.href, frameTitle: document.title };
            } catch (error) {
              return { ok: true, found: false, code: "frame_locate_error", error: String(error), frameUrl: location.href, frameTitle: document.title, retryable: true };
            }
          },
          args: [locateOptions],
        }));
        frameResults = executions.map((item) => ({ ...item.result, frameId: item.frameId, documentId: item.documentId || null }));
        frameDiagnostics = frameResults.map((item) => ({
          frameId: item.frameId,
          documentId: item.documentId || null,
          url: item.frameUrl || null,
          title: item.frameTitle || null,
          found: item.found === true,
          code: item.code || null,
          documentType: item.documentType || null,
          strategyUsed: item.strategyUsed || null,
          steps: Number(item.diagnostics?.steps || 0),
          error: item.error || null,
        }));
      } catch (error) {
        frameDiagnostics.push({ attempt: attempt + 1, found: false, code: "frame_injection_failed", error: String(error) });
      }
      if (frameResults.some((item) => item.found === true) || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    }

    const found = frameResults.filter((item) => item.found === true).sort((a, b) => {
      const aSteps = Number(a.diagnostics?.steps || 0);
      const bSteps = Number(b.diagnostics?.steps || 0);
      return aSteps - bSteps;
    })[0];
    if (found) {
      return { content: [{ type: "text", text: JSON.stringify({
        ...found,
        selectedFrame: { frameId: found.frameId, documentId: found.documentId || null, url: found.frameUrl || null, title: found.frameTitle || null },
        frameDiagnostics: frameDiagnostics.slice(0, 30),
        backend: "browser_session",
        readOnly: true,
      }, null, 2) }] };
    }

    const best = frameResults.sort((a, b) => Number(b.diagnostics?.targetsTried || 0) - Number(a.diagnostics?.targetsTried || 0))[0] || {};
    return { content: [{ type: "text", text: JSON.stringify({
      ok: true,
      found: false,
      code: best.code || "target_not_found_in_frames",
      query: args.query || null,
      strategyRequested: args.strategy || "auto",
      documentType: best.documentType || args.documentType || "auto",
      recommendedFallback: best.recommendedFallback || ((args.strategy || "auto") === "scroll_only" ? "auto" : "refresh_index_or_retry"),
      retryable: true,
      frameDiagnostics: frameDiagnostics.slice(0, 30),
      backend: "browser_session",
      readOnly: true,
    }, null, 2) }] };
  },

  async browser_app_inspect(args) {
    let tabId = Number(args.tabId || 0);
    if (!tabId) {
      const active = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = active[0]?.id || 0;
    }
    if (!tabId) return { content: [{ type: "text", text: JSON.stringify({ ok: false, code: "active_tab_not_found" }) }] };
    const tab = await chrome.tabs.get(tabId);
    if (!/^https?:/i.test(tab.url || "")) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, code: "unsupported_page_scheme", tabId, url: tab.url || null }, null, 2) }] };
    }
    let executions = [];
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        files: ["web-app-core.js", "web-app-reader.js"],
      });
      executions = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: async (options) => {
          const runtime = globalThis.OpenClaudeWebAppReader;
          if (!runtime?.inspect) return { ok: false, code: "browser_app_reader_runtime_missing", frameUrl: location.href, frameTitle: document.title };
          try { return { ...(await runtime.inspect(options)), frameUrl: location.href, frameTitle: document.title }; }
          catch (error) { return { ok: false, code: "browser_app_inspect_failed", error: String(error), frameUrl: location.href, frameTitle: document.title }; }
        },
        args: [args || {}],
      });
    } catch (error) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, code: "browser_app_frame_injection_failed", error: String(error), tabId }, null, 2) }] };
    }
    const results = executions.map((item) => ({ ...item.result, frameId: item.frameId, documentId: item.documentId || null }));
    const best = results.filter((item) => item?.ok).sort((a, b) => {
      const scoreA = Number(a.dataSurfaces?.length || 0) * 1000 + Number(a.details?.length || 0) * 20 + (a.appProfile?.product !== "generic_web_app" ? 3000 : 0);
      const scoreB = Number(b.dataSurfaces?.length || 0) * 1000 + Number(b.details?.length || 0) * 20 + (b.appProfile?.product !== "generic_web_app" ? 3000 : 0);
      return scoreB - scoreA;
    })[0];
    return { content: [{ type: "text", text: JSON.stringify(best ? {
      ...best,
      tabId,
      selectedFrame: { frameId: best.frameId, documentId: best.documentId, url: best.frameUrl, title: best.frameTitle },
      frameDiagnostics: results.map((item) => ({
        frameId: item.frameId,
        ok: item.ok === true,
        code: item.code || null,
        url: item.frameUrl || null,
        appProduct: item.appProfile?.product || null,
        surfaceCount: item.dataSurfaces?.length || 0,
        error: item.error || null,
      })),
      backend: "browser_session",
      readOnly: true,
    } : {
      ok: false,
      code: "browser_app_not_readable_in_frames",
      tabId,
      frameDiagnostics: results,
      backend: "browser_session",
      readOnly: true,
    }, null, 2) }] };
  },

  async browser_app_query(args) {
    const parse = (response) => {
      const text = response?.content?.find?.((item) => item?.type === "text")?.text;
      if (!text) return null;
      try { return JSON.parse(text); } catch { return null; }
    };
    let tabId = Number(args.tabId || 0);
    if (!tabId) {
      const active = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = active[0]?.id || 0;
    }
    if (!tabId) return { content: [{ type: "text", text: JSON.stringify({ ok: false, found: false, code: "active_tab_not_found" }) }] };
    const tab = await chrome.tabs.get(tabId);
    if (!/^https?:/i.test(tab.url || "")) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, found: false, code: "unsupported_page_scheme", tabId, url: tab.url || null }, null, 2) }] };
    }
    let executions = [];
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        files: ["web-app-core.js", "web-app-reader.js"],
      });
      executions = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: async (options) => {
          const runtime = globalThis.OpenClaudeWebAppReader;
          if (!runtime?.query) return { ok: false, found: false, code: "browser_app_reader_runtime_missing", frameUrl: location.href, frameTitle: document.title };
          try { return { ...(await runtime.query(options)), frameUrl: location.href, frameTitle: document.title }; }
          catch (error) { return { ok: false, found: false, code: "browser_app_query_failed", error: String(error), frameUrl: location.href, frameTitle: document.title }; }
        },
        args: [args || {}],
      });
    } catch (error) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, found: false, code: "browser_app_frame_injection_failed", error: String(error), tabId }, null, 2) }] };
    }
    const results = executions.map((item) => ({ ...item.result, frameId: item.frameId, documentId: item.documentId || null }));
    const best = results.filter((item) => item?.ok).sort((a, b) => {
      const scoreA = (a.found ? 100000 : 0) + Number(a.resolvedEntities?.length || 0) * 5000 + Number(a.structuredData?.matches?.length || 0) * 1500 + Number(a.matches?.length || 0) * 1000 + Number(a.detailMatches?.length || 0) * 100 + Number(a.scan?.uniqueRowsVisited || 0);
      const scoreB = (b.found ? 100000 : 0) + Number(b.resolvedEntities?.length || 0) * 5000 + Number(b.structuredData?.matches?.length || 0) * 1500 + Number(b.matches?.length || 0) * 1000 + Number(b.detailMatches?.length || 0) * 100 + Number(b.scan?.uniqueRowsVisited || 0);
      return scoreB - scoreA;
    })[0];
    if (!best) {
      return { content: [{ type: "text", text: JSON.stringify({
        ok: false,
        found: false,
        code: "browser_app_query_failed_in_all_frames",
        tabId,
        frameDiagnostics: results,
        backend: "browser_session",
        readOnly: true,
      }, null, 2) }] };
    }

    const base = {
      ...best,
      tabId,
      selectedFrame: { frameId: best.frameId, documentId: best.documentId, url: best.frameUrl, title: best.frameTitle },
      frameDiagnostics: results.map((item) => ({
        frameId: item.frameId,
        ok: item.ok === true,
        found: item.found === true,
        code: item.code || null,
        url: item.frameUrl || null,
        appProduct: item.appProfile?.product || null,
        matchCount: item.matches?.length || 0,
        structuredMatchCount: item.structuredData?.matches?.length || 0,
        resolvedEntityCount: item.resolvedEntities?.length || 0,
        rowsVisited: item.scan?.uniqueRowsVisited || 0,
        error: item.error || null,
      })),
      backend: "browser_session",
      readOnly: true,
    };

    const followMode = String(args.followDetails || "auto");
    const missingFields = base.fieldMatches?.missingFields || [];
    const shouldFollow = followMode === "always" || (followMode === "auto" && Array.isArray(args.fields) && args.fields.length > 0 && missingFields.length > 0);
    if (!shouldFollow || !base.found || !(base.detailCandidates || []).length) {
      base.detailLookup = { attempted: false, mode: followMode, reason: shouldFollow ? "no_safe_detail_links" : "not_required" };
      return { content: [{ type: "text", text: JSON.stringify(base, null, 2) }] };
    }

    const detailPages = [];
    const detailFacts = [];
    const links = (base.detailCandidates || []).slice(0, Math.max(1, Math.min(3, Number(args.maxDetailLinks || 2))));
    for (const detailLink of links) {
      let detailTabId = 0;
      try {
        const detailTab = await chrome.tabs.create({ url: detailLink.href, active: false });
        detailTabId = detailTab.id || 0;
        if (!detailTabId) continue;
        await new Promise((resolve) => {
          let finished = false;
          const done = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          };
          const listener = (updatedTabId, changeInfo) => {
            if (updatedTabId === detailTabId && changeInfo.status === "complete") done();
          };
          const timer = setTimeout(done, Math.max(3000, Math.min(30000, Number(args.detailTimeoutMs || 15000))));
          chrome.tabs.onUpdated.addListener(listener);
        });
        await new Promise((resolve) => setTimeout(resolve, Math.max(200, Math.min(3000, Number(args.detailSettleMs || 800)))));
        const inspectResponse = await toolHandlers.browser_app_inspect({
          tabId: detailTabId,
          maxDetailPairs: 300,
          maxTextChars: 40000,
          maxSurfaces: 6,
        });
        const detail = parse(inspectResponse);
        const facts = (detail?.confirmedFacts || []).map((fact) => ({ ...fact, sourceUrl: fact.sourceUrl || detailLink.href }));
        detailFacts.push(...facts);
        detailPages.push({
          ok: detail?.ok === true,
          href: detailLink.href,
          linkText: detailLink.text || null,
          title: detail?.title || null,
          appProfile: detail?.appProfile || null,
          details: detail?.details || [],
          confirmedFacts: facts,
          artifacts: detail?.artifacts || null,
          temporaryBackgroundTab: true,
          currentUserTabChanged: false,
        });
      } catch (error) {
        detailPages.push({
          ok: false,
          href: detailLink.href,
          linkText: detailLink.text || null,
          error: String(error),
          temporaryBackgroundTab: true,
          currentUserTabChanged: false,
        });
      } finally {
        if (detailTabId) {
          try { await chrome.tabs.remove(detailTabId); } catch {}
        }
      }
    }

    const allFacts = [...(base.confirmedFacts || []), ...detailFacts];
    const seenFacts = new Set();
    base.confirmedFacts = allFacts.filter((fact) => {
      const key = String(fact.field || "").toLowerCase() + "|" + String(fact.value || "") + "|" + String(fact.sourceUrl || "");
      if (seenFacts.has(key)) return false;
      seenFacts.add(key);
      return true;
    });
    if (Array.isArray(args.fields) && args.fields.length) {
      const matches = [];
      const stillMissing = [];
      for (const requestedField of args.fields) {
        const needle = String(requestedField).trim().toLowerCase();
        const facts = base.confirmedFacts.filter((fact) => {
          const field = String(fact.field || "").trim().toLowerCase();
          return field === needle || field.includes(needle) || needle.includes(field);
        });
        if (facts.length) matches.push({ requestedField, facts });
        else stillMissing.push(requestedField);
      }
      base.fieldMatches = { requestedFields: args.fields, matches, missingFields: stillMissing };
    }
    base.detailLookup = {
      attempted: true,
      mode: followMode,
      pagesVisited: detailPages.length,
      detailPages,
      temporaryBackgroundTabs: true,
      currentUserTabChanged: false,
    };
    base.diagnostics = {
      ...(base.diagnostics || {}),
      detailPagesReadWithoutClicks: detailPages.length,
      currentUserTabChanged: false,
    };
    return { content: [{ type: "text", text: JSON.stringify(base, null, 2) }] };
  },



  async tabs_context_mcp(args) {
    let tabs = await chrome.tabs.query({});
    if (!tabs.length && args?.createIfEmpty) tabs = [await chrome.tabs.create({ url: 'about:blank', active: true })];
    const availableTabs = tabs.filter((tab) => tab.id).map((tab) => ({ tabId: tab.id, windowId: tab.windowId, title: tab.title || 'Untitled', url: tab.url || '', active: tab.active === true }));
    return { content: [{ type: 'text', text: JSON.stringify({ availableTabs }, null, 2) }] };
  },
  async tabs_create_mcp(args) {
    const tab = await chrome.tabs.create({ url: args?.url || 'about:blank', active: args?.active !== false });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tabId: tab.id, title: tab.title, url: tab.url }, null, 2) }] };
  },
  async navigate(args) {
    const tab = await getTab(args.tabId);
    if (!tab?.id) throw new Error('Target tab not found');
    if (args.url === 'back') await chrome.tabs.goBack(tab.id);
    else if (args.url === 'forward') await chrome.tabs.goForward(tab.id);
    else await chrome.tabs.update(tab.id, { url: /^(?:https?|about|chrome|brave|edge):/i.test(args.url) ? args.url : `https://${args.url}` });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tabId: tab.id }, null, 2) }] };
  },
  async computer(args) {
    const tab = await getTab(args.tabId); if (!tab?.id) throw new Error('Target tab not found');
    const tabId = tab.id; let coordinate = args.coordinate;
    if (!coordinate && args.ref) { const resolved = await resolveRef(tabId, args.ref); if (resolved) coordinate = [resolved.x, resolved.y]; }
    const action = args.action;
    if (action === 'screenshot') {
      const result = await screenshot(tabId);
      return { content: [{ type: 'text', text: `Screenshot ${result.imageId}` }, { type: 'image', data: result.base64, mimeType: 'image/jpeg' }] };
    }
    if (action === 'zoom') {
      const result = await screenshot(tabId, args.region);
      return { content: [{ type: 'text', text: `Screenshot ${result.imageId}` }, { type: 'image', data: result.base64, mimeType: 'image/jpeg' }] };
    }
    if (action === 'wait') { await sleep(Math.min(30000, Math.max(0, Number(args.duration || 1) * 1000))); return { content: [{ type: 'text', text: 'Wait complete' }] }; }
    if (action === 'scroll_to') { const response = await sendContentMessage(tabId, { type: 'scrollRefIntoView', ref: args.ref, block: args.block || 'center' }); return { content: [{ type: 'text', text: JSON.stringify(response?.result || response) }] }; }
    if (action === 'type') { await cdp(tabId, 'Input.insertText', { text: String(args.text || '') }); return { content: [{ type: 'text', text: 'Text inserted' }] }; }
    if (action === 'key') {
      const keys = String(args.text || '').split(/\s+/).filter(Boolean);
      for (let r = 0; r < Math.min(100, Number(args.repeat || 1)); r += 1) for (const key of keys) {
        await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key });
        await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key });
      }
      return { content: [{ type: 'text', text: 'Keys dispatched' }] };
    }
    if (action === 'scroll') {
      const x = coordinate?.[0] ?? 300, y = coordinate?.[1] ?? 300;
      const amount = Math.min(10, Number(args.scroll_amount || 3)) * 120;
      const dx = args.scroll_direction === 'left' ? -amount : args.scroll_direction === 'right' ? amount : 0;
      const dy = args.scroll_direction === 'up' ? -amount : args.scroll_direction === 'down' ? amount : 0;
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
      return { content: [{ type: 'text', text: 'Scrolled' }] };
    }
    if (!coordinate) throw new Error(`Coordinate or ref required for ${action}`);
    const [x,y] = coordinate;
    if (action === 'hover') { await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); return { content: [{ type: 'text', text: 'Hovered' }] }; }
    if (action === 'left_click_drag') {
      const [sx,sy] = args.start_coordinate || coordinate;
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x:sx, y:sy, button:'left', clickCount:1 });
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button:'left' });
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button:'left', clickCount:1 });
      return { content: [{ type: 'text', text: 'Dragged' }] };
    }
    const button = action === 'right_click' ? 'right' : 'left';
    const clickCount = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1;
    await cdp(tabId, 'Input.dispatchMouseEvent', { type:'mouseMoved', x, y });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type:'mousePressed', x, y, button, clickCount });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button, clickCount });
    return { content: [{ type: 'text', text: 'Click dispatched' }] };
  },
  async find(args) {
    const tab = await getTab(args.tabId); const response = await sendContentMessage(tab.id, { type:'findElements', query:args.query, limit:args.limit });
    return { content: [{ type:'text', text:JSON.stringify(response?.result || response, null, 2) }] };
  },
  async form_input(args) {
    const tab = await getTab(args.tabId); const response = await sendContentMessage(tab.id, { type:'setFormValue', ref:args.ref, value:args.value });
    return { content: [{ type:'text', text:JSON.stringify(response?.result || response, null, 2) }] };
  },
  async get_page_text(args) {
    const tab = await getTab(args.tabId); const response = await sendContentMessage(tab.id, { type:'getPageText', maxChars:args.maxChars });
    return { content: [{ type:'text', text:JSON.stringify(response?.result || response, null, 2) }] };
  },
  async read_page(args) {
    const tab = await getTab(args.tabId); const response = await sendContentMessage(tab.id, { type:'readPage', options:args });
    return { content: [{ type:'text', text:JSON.stringify(response?.result || response, null, 2) }] };
  },
  async javascript_tool(args) {
    const tab = await getTab(args.tabId);
    const result = await cdp(tab.id, 'Runtime.evaluate', { expression:String(args.text || ''), awaitPromise:true, returnByValue:true, userGesture:false });
    return { content: [{ type:'text', text:JSON.stringify(result?.result?.value ?? result?.result?.description ?? null, null, 2) }] };
  },
  async read_console_messages(args) {
    const tab = await getTab(args.tabId); await ensureDomain(tab.id, 'Runtime');
    return { content: [{ type:'text', text:JSON.stringify((consoleMessages.get(tab.id) || []).slice(-Math.min(1000, Number(args.limit || 200))), null, 2) }] };
  },
  async read_network_requests(args) {
    const tab = await getTab(args.tabId); await ensureDomain(tab.id, 'Network');
    let list = networkRequests.get(tab.id) || [];
    if (args.urlPattern) list = list.filter((item) => String(item.url || '').includes(args.urlPattern));
    return { content: [{ type:'text', text:JSON.stringify(list.slice(-Math.min(2000, Number(args.limit || 300))), null, 2) }] };
  },
  async resize_window(args) {
    const tab = await getTab(args.tabId); await chrome.windows.update(tab.windowId, { width:Number(args.width), height:Number(args.height) });
    return { content: [{ type:'text', text:'Window resized' }] };
  },
  async upload_image(args) {
    const tab = await getTab(args.tabId);
    const result = await chrome.scripting.executeScript({ target:{ tabId:tab.id }, func: async (selector, data, filename, mimeType) => {
      const input = document.querySelector(selector || 'input[type=file]'); if (!input) return { ok:false, code:'file_input_not_found' };
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const file = new File([bytes], filename || 'upload.png', { type:mimeType || 'image/png' });
      const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles:true })); return { ok:true, name:file.name, size:file.size };
    }, args:[args.selector, args.base64, args.filename, args.mimeType] });
    return { content: [{ type:'text', text:JSON.stringify(result[0]?.result || null, null, 2) }] };
  },
  async gif_creator() { return { content: [{ type:'text', text:JSON.stringify({ ok:false, code:'not_implemented' }) }] }; },
  async shortcuts_list() { return { content: [{ type:'text', text:'[]' }] }; },
  async shortcuts_execute() { return { content: [{ type:'text', text:JSON.stringify({ ok:false, code:'not_implemented' }) }] }; },
  async switch_browser() { return { content: [{ type:'text', text:JSON.stringify({ ok:false, code:'not_implemented' }) }] }; },
  async update_plan(args) { return { content: [{ type:'text', text:JSON.stringify({ ok:true, plan:args }, null, 2) }] }; },
};

const PUBLIC_MAP_TOOLS = new Set(['browser_map', 'browser_locate', 'browser_read', 'browser_act']);
const INTERNAL_RUNTIME_TOOLS = new Set(['__pure_map_page_context', '__pure_map_build_navigation_map', '__pure_map_read_target', '__pure_map_act_target', '__pure_map_figma_ws_capture']);
const INTERNAL_ROUTE_MARKER = 'pure-map-internal-v1';

function isAuthorizedInternalTool(tool, args) {
  return INTERNAL_RUNTIME_TOOLS.has(tool)
    && args?.__pureMapInternal === true
    && args?.__internalRoute === INTERNAL_ROUTE_MARKER
    && Number(args?.__protocolVersion) === 13;
}

async function handleToolRequest(id, tool, args) {
  const requestKey = String(id);
  const fingerprint = argsFingerprint(args);
  const completed = completedToolResponses.get(requestKey);
  if (completed?.message) {
    // Replay only when the arguments match; a colliding id with different
    // arguments must never receive a stale result silently.
    if (!completed.fingerprint || completed.fingerprint === fingerprint) { postNative(completed.message); return; }
    completedToolResponses.delete(requestKey);
  }
  const inflight = inflightToolRequests.get(requestKey);
  if (inflight) {
    if (inflight.fingerprint === fingerprint) {
      sendProgress(requestKey, 'duplicate_request_waiting', { tool });
      return;
    }
    // Same id, different arguments: an id collision, not a retry. Fail fast
    // instead of silently attaching this request to an unrelated stuck task.
    postNative({ id: requestKey, type: 'tool_error', error: `request_id_conflict: request ${requestKey} is already running ${inflight.tool} with different arguments` });
    return;
  }
  const isPublicTool = PUBLIC_MAP_TOOLS.has(tool);
  const isInternalTool = isAuthorizedInternalTool(tool, args);
  const entry = { tool, startedAt: Date.now(), internal: isInternalTool, fingerprint, timer: null, cancel: null, touch: null };
  inflightToolRequests.set(requestKey, entry);
  if (isPublicTool) globalThis.__claudeSidebarBrowserTaskRuntime?.toolStarted?.(id, tool, args);
  // Guard promise: guarantees the request reaches a terminal state (and the
  // inflight slot is released) even when the underlying executor hangs.
  // Idle-based: entry.touch() re-arms it on genuine progress; the hard cap
  // (measured from start) cannot be extended by anything.
  const guard = new Promise((_resolve, reject) => {
    const fail = (code, seconds) => {
      markRequestAborted(requestKey);
      reject(Object.assign(
        new Error(`${code}: ${tool} did not reach a terminal state within ${seconds}s. This result is terminal for this request — do not immediately retry with the same or slightly different parameters.`),
        { code },
      ));
    };
    const arm = () => {
      if (entry.timer) clearTimeout(entry.timer);
      const hardRemainingMs = entry.startedAt + TOOL_EXECUTION_HARD_MS - Date.now();
      const isHardBound = hardRemainingMs <= TOOL_EXECUTION_IDLE_MS;
      const waitMs = Math.max(0, Math.min(TOOL_EXECUTION_IDLE_MS, hardRemainingMs));
      entry.timer = setTimeout(() => fail(
        isHardBound ? 'tool_execution_hard_deadline' : 'tool_execution_timeout',
        Math.round((isHardBound ? TOOL_EXECUTION_HARD_MS : TOOL_EXECUTION_IDLE_MS) / 1000),
      ), waitMs);
    };
    entry.touch = arm;
    arm();
    entry.cancel = (reason) => {
      markRequestAborted(requestKey);
      reject(Object.assign(new Error(`tool_cancelled: ${reason}`), { code: 'tool_cancelled' }));
    };
  });
  try {
    if (!isPublicTool && !isInternalTool) {
      const error = new Error(`legacy_tool_removed: ${tool}. Use browser_map, browser_locate, browser_read, or browser_act.`);
      error.code = 'legacy_tool_removed';
      throw error;
    }
    const handler = toolHandlers[tool];
    if (!handler) throw new Error(isInternalTool ? `Unknown internal runtime route: ${tool}` : `Unknown browser map tool: ${tool}`);
    const executorArgs = { ...(args || {}), __requestId: id };
    const executor = () => handler(executorArgs);
    const run = isPublicTool && globalThis.__claudeSidebarBrowserTaskRuntime?.runCancellable
      ? globalThis.__claudeSidebarBrowserTaskRuntime.runCancellable(id, executor)
      : Promise.resolve().then(executor);
    const result = await Promise.race([run, guard]);
    sendResponse(id, result);
  } catch (error) { sendError(id, error); }
  finally {
    if (entry.timer) clearTimeout(entry.timer);
    inflightToolRequests.delete(requestKey);
  }
}

connectNativeHost();
