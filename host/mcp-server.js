#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { LarkIndexManager } from './lark-index/lark-index-manager.mjs';
import { PageContextManager } from './page-context/page-context-manager.mjs';
import { findNumberedRequirement, buildDocumentSummaryContext, analyzeDocumentCoverage } from './lark-index/lark-reliable-reader.mjs';
import { MapEngine } from './map/map-engine.mjs';
import { TaskLedger } from './read/task-ledger.mjs';
import { PendingRequestTracker } from './read/pending-request-tracker.mjs';
import { summaryFromBlocks, sectionFromBlocks } from './read/content-store-reader.mjs';

const VERSION = '0.15.3';
const PROTOCOL_VERSION = 13;
const DEFAULT_PORT = 18765;
const INTERNAL_PAGE_CONTEXT_TOOL = '__pure_map_page_context';
const INTERNAL_ROUTE_MARKER = 'pure-map-internal-v1';
const INTERNAL_NAVIGATION_BUILD_TOOL = '__pure_map_build_navigation_map';
const INTERNAL_READ_TARGET_TOOL = '__pure_map_read_target';
const INTERNAL_ACT_TARGET_TOOL = '__pure_map_act_target';
const SAFE_REPLAY_TOOLS = new Set(['browser_map','browser_locate','browser_read','browser_act', INTERNAL_PAGE_CONTEXT_TOOL, INTERNAL_NAVIGATION_BUILD_TOOL, INTERNAL_READ_TARGET_TOOL, INTERNAL_ACT_TARGET_TOOL]);

function configPort() {
  const candidates = [
    process.env.CLAUDE_SIDEBAR_MCP_PORT,
    (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'open-claude-in-chrome', 'config.json'), 'utf8')).port; } catch { return null; } })(),
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0 && number < 65536) return number;
  }
  return DEFAULT_PORT;
}
const TCP_PORT = configPort();
const pidfilePath = path.join(os.tmpdir(), `claude-sidebar-mcp-${TCP_PORT}.pid`);

let mode = 'starting';
let recoveryState = 'starting';
let tcpServer = null;
let nativeHostSocket = null;
let nativeHostConnectedAt = null;
let extensionReadyAt = null;
let extensionVersion = null;
let extensionProtocolVersion = null;
let extensionRuntime = null;
let extensionBootId = null;
let primaryVersion = null;
let primaryProtocolVersion = null;
let primaryCompatible = null;
let primarySocket = null;
let primaryConnectedAt = null;
let clientBuffer = Buffer.alloc(0);
let clientIdCounter = 0;
let recoveryAttempt = 0;
let lastError = null;
// Terminal-state guarantee for every dispatched tool request: idle timeout
// (efficacious progress re-arms), hard deadline (nothing extends), and
// boot-nonce ids so requests never collide across MCP server restarts.
const pendingTracker = new PendingRequestTracker({
  idleTimeoutForTool: (tool) => timeoutForTool(tool),
  hardDeadlineMs: 600000,
  nonEfficaciousStages: ['duplicate_request_waiting'],
  onTimeout: (id, entry) => requestToolCancel(id, entry, 'timeout'),
});
const pendingRequests = pendingTracker.requests;
const clientSockets = new Map();
const clientRequestMap = new Map();
const forwardedQueue = new Map();

function writeLine(socket, value) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  try { socket.write(`${JSON.stringify(value)}\n`); return true; } catch { return false; }
}
function writePidfile() { try { fs.writeFileSync(pidfilePath, String(process.pid)); } catch {} }
function cleanupPidfile() { try { if (fs.readFileSync(pidfilePath, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidfilePath); } catch {} }
function timeoutForTool(tool) {
  // Internal build/read routes execute the same long-running work as their
  // public counterparts (virtual-scroll materialization, sequential read
  // plans) and need the same idle budget — 60s killed healthy document reads.
  if (['browser_map', 'browser_locate', 'browser_read', INTERNAL_NAVIGATION_BUILD_TOOL, INTERNAL_READ_TARGET_TOOL].includes(tool)) return 180000;
  return 60000;
}
function getSidebarConnectionStatus() {
  return {
    ok: true,
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    mode,
    recoveryState,
    primaryConnected: mode === 'primary' || Boolean(primarySocket && !primarySocket.destroyed),
    nativeHostConnected: Boolean(nativeHostSocket && !nativeHostSocket.destroyed),
    primaryConnectedAt,
    nativeHostConnectedAt,
    extensionReadyAt,
    extensionVersion,
    extensionProtocolVersion,
    extensionRuntime,
    extensionBootId,
    extensionCompatible: extensionVersion === VERSION && Number(extensionProtocolVersion) === PROTOCOL_VERSION,
    primaryVersion,
    primaryProtocolVersion,
    primaryCompatible,
    lastError,
    pendingRequestCount: pendingRequests.size,
    activeRequests: [...pendingRequests.entries()].slice(0, 20).map(([id, entry]) => ({ id, tool: entry.tool, dispatched: entry.dispatched, replayable: entry.replayable, lastProgressAt: entry.lastProgressAt || null, lastProgress: entry.lastProgress || null })),
    connectedClientCount: clientSockets.size,
    recoveryAttempt,
    port: TCP_PORT,
  };
}
function extensionIsCompatible() {
  return extensionVersion === VERSION && Number(extensionProtocolVersion) === PROTOCOL_VERSION;
}
function transportReady() {
  return mode === 'primary'
    ? Boolean(nativeHostSocket && !nativeHostSocket.destroyed && extensionReadyAt && extensionIsCompatible())
    : Boolean(primarySocket && !primarySocket.destroyed && primaryCompatible === true);
}
function transportCompatibilityError() {
  if (mode === 'primary' && extensionReadyAt && !extensionIsCompatible()) {
    const error = new Error(`Claude Sidebar runtime version mismatch: MCP ${VERSION}/protocol ${PROTOCOL_VERSION}, Extension ${extensionVersion || 'unknown'}/protocol ${extensionProtocolVersion || 'unknown'}. Reload the extension, fully quit Chrome, and restart the Main Session.`);
    error.code = 'runtime_version_mismatch';
    return error;
  }
  if (mode === 'client' && primaryCompatible === false) {
    const error = new Error(`Claude Sidebar MCP primary version mismatch: client ${VERSION}/protocol ${PROTOCOL_VERSION}, primary ${primaryVersion || 'unknown'}/protocol ${primaryProtocolVersion || 'unknown'}. A stale MCP primary is still running on port ${TCP_PORT}. Reinstall v${VERSION} or stop that exact process, then start a new Main Session.`);
    error.code = 'mcp_primary_version_mismatch';
    return error;
  }
  return null;
}
function waitForTransport(timeoutMs = 30000) {
  const compatibilityError = transportCompatibilityError();
  if (compatibilityError) return Promise.reject(compatibilityError);
  if (transportReady()) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const error = transportCompatibilityError();
      if (error) { clearInterval(timer); reject(error); return; }
      if (transportReady()) { clearInterval(timer); resolve(true); return; }
      if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        const timeout = new Error(`Browser transport did not become ready within ${Math.round(timeoutMs / 1000)} seconds. State=${recoveryState}, native=${Boolean(nativeHostSocket && !nativeHostSocket.destroyed)}, extensionHello=${Boolean(extensionReadyAt)}.`);
        timeout.code = 'browser_transport_unavailable';
        reject(timeout);
      }
    }, 100);
    timer.unref?.();
  });
}
function dispatchPendingEntry(id, entry) {
  const message = { id, type: 'tool_request', tool: entry.tool, args: entry.args };
  if (mode === 'primary') return writeLine(nativeHostSocket, message);
  return writeLine(primarySocket, message);
}
// Ask the extension to abandon a timed-out or superseded request so its
// inflight slot is released instead of blocking every retry forever.
function requestToolCancel(id, entry, reason = 'timeout') {
  const message = { id, type: 'tool_cancel', tool: entry?.tool || null, reason };
  if (mode === 'primary') writeLine(nativeHostSocket, message);
  else writeLine(primarySocket, message);
}
function touchPendingProgress(id, progress) {
  return pendingTracker.touchProgress(id, progress);
}
async function sendToExtension(tool, args = {}) {
  const id = pendingTracker.nextId();
  return new Promise(async (resolve, reject) => {
    const entry = { resolve, reject, timer: null, tool, args, dispatched: false, replayable: SAFE_REPLAY_TOOLS.has(tool), resent: false, lastProgress: null, lastProgressAt: null };
    pendingTracker.create(id, entry);
    try {
      await waitForTransport();
      entry.dispatched = dispatchPendingEntry(id, entry);
      if (!entry.dispatched) throw new Error('Failed to send tool request to browser transport.');
    } catch (error) {
      pendingTracker.settle(id);
      reject(error);
    }
  });
}

function settleLocalResponse(msg) {
  const entry = pendingTracker.settle(msg.id);
  if (!entry) return false;
  if (msg.type === 'tool_error') entry.reject(new Error(msg.error || 'Tool execution failed'));
  else entry.resolve(msg.result);
  return true;
}
function dispatchQueuedAfterExtensionReady() {
  for (const [id, entry] of pendingRequests) {
    if (!entry.dispatched || (entry.replayable && !entry.resent)) {
      entry.resent = entry.dispatched || entry.resent;
      entry.dispatched = dispatchPendingEntry(id, entry);
    }
  }
  for (const [id, queued] of forwardedQueue) {
    if (writeLine(nativeHostSocket, queued.message)) forwardedQueue.delete(id);
  }
}
function handleNativeMessage(msg) {
  if (!msg || msg.type === 'heartbeat' || msg.type === 'native_hello') return;
  if (msg.type === 'extension_hello') {
    extensionReadyAt = new Date().toISOString();
    extensionVersion = msg.version || null;
    extensionProtocolVersion = msg.protocolVersion || null;
    extensionRuntime = msg.runtime || null;
    extensionBootId = msg.bootId || null;
    if (!extensionIsCompatible()) {
      recoveryState = 'version_mismatch';
      lastError = `Extension ${extensionVersion || 'unknown'}/protocol ${extensionProtocolVersion || 'unknown'} is incompatible with MCP ${VERSION}/protocol ${PROTOCOL_VERSION}`;
      return;
    }
    recoveryState = 'connected';
    lastError = null;
    dispatchQueuedAfterExtensionReady();
    return;
  }
  const route = clientRequestMap.get(String(msg.id || ''));
  if (route) {
    const socket = clientSockets.get(route.clientId);
    if (socket) writeLine(socket, { ...msg, id: route.originalId });
    if (msg.type !== 'tool_progress') clientRequestMap.delete(String(msg.id));
    return;
  }
  if (msg.type === 'tool_progress') { touchPendingProgress(msg.id, msg.progress); return; }
  settleLocalResponse(msg);
}
function processLines(state, chunk, onMessage) {
  state.buffer = Buffer.concat([state.buffer || Buffer.alloc(0), chunk]);
  let index;
  while ((index = state.buffer.indexOf(10)) >= 0) {
    const line = state.buffer.subarray(0, index).toString('utf8').trim();
    state.buffer = state.buffer.subarray(index + 1);
    if (!line) continue;
    try { onMessage(JSON.parse(line)); } catch {}
  }
}
function attachNativeHost(socket, initial = Buffer.alloc(0)) {
  if (nativeHostSocket && nativeHostSocket !== socket && !nativeHostSocket.destroyed) nativeHostSocket.destroy();
  nativeHostSocket = socket;
  nativeHostConnectedAt = new Date().toISOString();
  extensionReadyAt = null;
  extensionVersion = null;
  extensionProtocolVersion = null;
  extensionRuntime = null;
  extensionBootId = null;
  recoveryState = 'waiting_for_extension';
  const state = { buffer: Buffer.alloc(0) };
  if (initial.length) processLines(state, initial, handleNativeMessage);
  socket.on('data', (chunk) => processLines(state, chunk, handleNativeMessage));
  if (!extensionReadyAt) {
    writeLine(socket, {
      type: 'request_extension_hello',
      version: VERSION,
      protocolVersion: PROTOCOL_VERSION,
      // The extension compares this nonce to detect a *different* primary
      // process (fresh id space) and drop stale inflight/completed entries;
      // a reconnect of the same primary keeps them.
      primaryBootId: pendingTracker.bootNonce,
      reason: 'new_mcp_primary',
    });
  }
  socket.on('error', (error) => { lastError = error.message; });
  socket.on('close', () => {
    if (nativeHostSocket === socket) nativeHostSocket = null;
    extensionReadyAt = null;
    extensionVersion = null;
    extensionProtocolVersion = null;
    extensionRuntime = null;
    extensionBootId = null;
    recoveryState = 'waiting_for_native_host';
    for (const [id, entry] of pendingRequests) {
      if (!entry.dispatched || !entry.replayable) continue;
      entry.dispatched = false;
      entry.resent = false;
    }
  });
  // Requests are dispatched after the extension sends extension_hello. This
  // prevents the native process being mistaken for a ready browser runtime.
}
function attachClient(socket, initial = Buffer.alloc(0), hello = {}) {
  const clientId = String(++clientIdCounter);
  clientSockets.set(clientId, socket);
  const compatible = !hello.version || (hello.version === VERSION && Number(hello.protocolVersion) === PROTOCOL_VERSION);
  writeLine(socket, { type: 'client_ack', clientId, version: VERSION, protocolVersion: PROTOCOL_VERSION, compatible });
  const state = { buffer: Buffer.alloc(0) };
  const onMessage = (msg) => {
    if (!msg.id || (msg.type !== 'tool_request' && msg.type !== 'tool_cancel')) return;
    const prefixedId = `c${clientId}_${msg.id}`;
    if (msg.type === 'tool_cancel') {
      forwardedQueue.delete(prefixedId);
      writeLine(nativeHostSocket, { ...msg, id: prefixedId });
      return;
    }
    clientRequestMap.set(prefixedId, { clientId, originalId: msg.id });
    const message = { ...msg, id: prefixedId };
    if (!transportReady() || !writeLine(nativeHostSocket, message)) forwardedQueue.set(prefixedId, { message, createdAt: Date.now() });
  };
  if (initial.length) processLines(state, initial, onMessage);
  socket.on('data', (chunk) => processLines(state, chunk, onMessage));
  socket.on('error', () => {});
  socket.on('close', () => {
    clientSockets.delete(clientId);
    for (const [id, route] of clientRequestMap) if (route.clientId === clientId) clientRequestMap.delete(id);
    for (const [id] of forwardedQueue) if (id.startsWith(`c${clientId}_`)) forwardedQueue.delete(id);
  });
}
function createPrimaryServer() {
  const server = net.createServer((socket) => {
    const state = { buffer: Buffer.alloc(0), classified: false };
    const timer = setTimeout(() => {
      if (!state.classified) { state.classified = true; socket.removeListener('data', early); attachNativeHost(socket, state.buffer); }
    }, 700);
    function early(chunk) {
      if (state.classified) return;
      state.buffer = Buffer.concat([state.buffer, chunk]);
      const index = state.buffer.indexOf(10);
      if (index < 0) return;
      let first = null;
      try { first = JSON.parse(state.buffer.subarray(0, index).toString('utf8').trim()); } catch {}
      state.classified = true;
      clearTimeout(timer);
      socket.removeListener('data', early);
      const rest = state.buffer.subarray(index + 1);
      if (first?.type === 'client_hello') attachClient(socket, rest, first);
      else if (first?.type === 'native_hello') attachNativeHost(socket, rest);
      else attachNativeHost(socket, state.buffer);
    }
    socket.on('data', early);
  });
  server.on('error', (error) => { lastError = error.message; });
  return server;
}
function connectClient() {
  if (mode !== 'client' || (primarySocket && !primarySocket.destroyed)) return;
  recoveryState = 'connecting_to_primary';
  const socket = net.createConnection({ port: TCP_PORT, host: '127.0.0.1' });
  primarySocket = socket;
  const state = { buffer: Buffer.alloc(0) };
  socket.once('connect', () => {
    recoveryAttempt = 0;
    primaryConnectedAt = new Date().toISOString();
    recoveryState = 'waiting_for_primary_ack';
    primaryVersion = null;
    primaryProtocolVersion = null;
    primaryCompatible = null;
    writeLine(socket, { type: 'client_hello', version: VERSION, protocolVersion: PROTOCOL_VERSION });
  });
  socket.on('data', (chunk) => processLines(state, chunk, (msg) => {
    if (msg.type === 'client_ack') {
      primaryVersion = msg.version || null;
      primaryProtocolVersion = msg.protocolVersion || null;
      primaryCompatible = msg.compatible !== false && primaryVersion === VERSION && Number(primaryProtocolVersion) === PROTOCOL_VERSION;
      recoveryState = primaryCompatible ? 'connected' : 'primary_version_mismatch';
      if (!primaryCompatible) {
        lastError = `Primary ${primaryVersion || 'unknown'}/protocol ${primaryProtocolVersion || 'unknown'} is incompatible with client ${VERSION}/protocol ${PROTOCOL_VERSION}`;
      } else {
        lastError = null;
        for (const [id, entry] of pendingRequests) {
          if (!entry.dispatched || entry.replayable) { entry.resent = entry.dispatched || entry.resent; entry.dispatched = dispatchPendingEntry(id, entry); }
        }
      }
      return;
    }
    if (msg.type === 'tool_progress') { touchPendingProgress(msg.id, msg.progress); return; }
    settleLocalResponse(msg);
  }));
  socket.on('error', (error) => { lastError = error.message; });
  socket.on('close', () => {
    if (primarySocket === socket) primarySocket = null;
    primaryCompatible = null;
    if (mode !== 'client') return;
    recoveryState = 'recovering_primary';
    for (const [, entry] of pendingRequests) if (entry.replayable) entry.dispatched = false;
    setTimeout(attemptPromotion, 200 + Math.floor(Math.random() * 600));
  });
}
function attemptPromotion() {
  if (mode !== 'client') return;
  recoveryAttempt += 1;
  recoveryState = 'electing_primary';
  const candidate = createPrimaryServer();
  candidate.once('error', (error) => {
    if (error.code === 'EADDRINUSE') { candidate.close?.(); setTimeout(connectClient, 300); }
    else { lastError = error.message; setTimeout(connectClient, 800); }
  });
  candidate.listen(TCP_PORT, '127.0.0.1', () => {
    mode = 'primary';
    tcpServer = candidate;
    recoveryState = 'waiting_for_native_host';
    writePidfile();
    process.stderr.write(`Promoted client to primary MCP server on :${TCP_PORT}\n`);
  });
}
async function startTransport() {
  tcpServer = createPrimaryServer();
  await new Promise((resolve) => {
    const onError = (error) => {
      if (error.code === 'EADDRINUSE') {
        mode = 'client';
        tcpServer = null;
        connectClient();
        resolve();
      } else {
        process.stderr.write(`TCP server error: ${error.message}\n`);
        process.exit(1);
      }
    };
    tcpServer.once('error', onError);
    tcpServer.listen(TCP_PORT, '127.0.0.1', () => {
      tcpServer.removeListener('error', onError);
      mode = 'primary';
      recoveryState = 'waiting_for_native_host';
      writePidfile();
      process.stderr.write(`Claude Sidebar primary MCP server listening on :${TCP_PORT}\n`);
      resolve();
    });
  });
}
function shutdown() {
  cleanupPidfile();
  for (const [, entry] of pendingRequests) { clearTimeout(entry.timer); entry.reject(new Error('Server shutting down')); }
  pendingRequests.clear();
  try { nativeHostSocket?.destroy(); } catch {}
  try { primarySocket?.destroy(); } catch {}
  try { tcpServer?.close(); } catch {}
  for (const socket of clientSockets.values()) try { socket.destroy(); } catch {}
  process.exit(0);
}
for (const signal of ['SIGTERM','SIGINT','SIGHUP']) process.on(signal, shutdown);
process.stdin.on('end', shutdown);
process.stdin.resume();
await startTransport();

function textResult(text) { return { content: [{ type: 'text', text: String(text) }] }; }
// Mixed text + image tool result. The installed Claude Code CLI (verified on
// 2.1.210) forwards MCP image content blocks to the model as native vision, so
// browser_read can hand a captured page image straight to the model.
function imageResult(text, image) {
  const content = [{ type: 'text', text: String(text) }];
  if (image?.base64) content.push({ type: 'image', data: String(image.base64), mimeType: String(image.mimeType || 'image/png') });
  return { content };
}
function parseExtensionJsonResult(result) {
  const text = result?.content?.find?.((part) => part?.type === 'text')?.text;
  if (!text) return result;
  try { return JSON.parse(text); } catch { return { ok: false, code: 'extension_result_not_json', raw: text }; }
}
async function rawExtensionJson(tool, args = {}) { return parseExtensionJsonResult(await sendToExtension(tool, args)); }
async function rawInternalPageContext(args = {}) {
  return rawExtensionJson(INTERNAL_PAGE_CONTEXT_TOOL, {
    ...args,
    __pureMapInternal: true,
    __internalRoute: INTERNAL_ROUTE_MARKER,
    __protocolVersion: PROTOCOL_VERSION,
  });
}

async function rawInternalExtension(tool, args = {}) {
  return rawExtensionJson(tool, {
    ...args,
    __pureMapInternal: true,
    __internalRoute: INTERNAL_ROUTE_MARKER,
    __protocolVersion: PROTOCOL_VERSION,
  });
}

const mapEngine = new MapEngine();
const taskLedger = new TaskLedger();

function pageIdentityFromResolved(resolved) {
  const identity = resolved?.identity || resolved || {};
  return {
    tabId: Number(identity.tabId || 0) || null,
    title: String(identity.title || ''),
    url: String(identity.url || ''),
    pageType: String(identity.pageType || ''),
  };
}

async function resolveMapPage(args = {}) {
  const resolved = await resolveBrowserTarget(args);
  if (!resolved?.ok) return resolved;
  const page = pageIdentityFromResolved(resolved);
  if (!page.tabId || !page.url) return { ok: false, code: 'page_identity_incomplete', page };
  return { ok: true, page, source: resolved.source || 'browser_context' };
}

function mapError(code, extra = {}) {
  return textResult(JSON.stringify({ ok: false, code, ...extra }, null, 2));
}

async function getExistingNavigationMap(args = {}) {
  const resolved = await resolveMapPage(args);
  if (!resolved?.ok) return resolved;
  const stored = mapEngine.getByPage(resolved.page);
  if (!stored.ok) return { ...stored, page: resolved.page };
  return { ok: true, page: resolved.page, map: stored.map };
}

async function handleBrowserMap(args = {}) {
  const resolved = await resolveMapPage(args);
  if (!resolved?.ok) return textResult(JSON.stringify(resolved, null, 2));
  const refresh = args.refresh === true;
  const result = await mapEngine.getOrCreate(
    resolved.page,
    async () => rawInternalExtension(INTERNAL_NAVIGATION_BUILD_TOOL, {
      tabId: resolved.page.tabId,
      maxFrames: args.maxFrames,
      maxNodesPerFrame: args.maxNodesPerFrame,
      maxAxNodes: args.maxAxNodes,
      maxBlocks: args.maxBlocks,
      chunkSize: args.chunkSize,
      refresh,
    }),
    { refresh },
  );
  if (!result?.ok) return textResult(JSON.stringify(result, null, 2));
  if (!result.reused && result.map?.kernelTrace) {
    // Compact per-stage build trace to stderr; the full trace lives in the persisted map file.
    try { console.error(JSON.stringify({ event: 'kernel_trace', pageKey: result.map.pageKey, trace: result.map.kernelTrace })); } catch {}
  }
  return textResult(JSON.stringify({
    ...result.status,
    reused: result.reused === true,
    refreshed: result.refreshed === true,
    // Deterministic same-tab page-change signal (e.g. video autoplay): only
    // present when the map was rebuilt because the page title changed.
    ...(result.pageChanged ? { pageChanged: result.pageChanged, pageChangeNotice: result.pageChangeNotice } : {}),
  }, null, 2));
}

async function handleBrowserLocate(args = {}) {
  if (args.refresh === true) return mapError('explicit_refresh_requires_browser_map', { message: 'Call browser_map with refresh=true only when the user explicitly requested a map refresh.' });
  const existing = await getExistingNavigationMap(args);
  if (!existing?.ok) return textResult(JSON.stringify(existing, null, 2));
  const query = args.query || args.locator || args.id || '';
  const result = mapEngine.locate(existing.map, query, { types: args.types, limit: args.limit, caseSensitive: args.caseSensitive });
  return textResult(JSON.stringify(result, null, 2));
}

function serveReadFromContentStore(map, anchor, args = {}) {
  const stored = mapEngine.store.readContent?.(map.pageKey);
  if (!stored?.ok) return null;
  // Version binding: content written by a different map version is stale
  // relative to the anchors and must not be served.
  if (Number(stored.content.mapVersion) !== Number(map.mapVersion)) return null;
  const blocks = stored.content.blocks;
  if (anchor.kind === 'document') {
    const summary = summaryFromBlocks(blocks, { maxChars: args.maxChars });
    if (!summary) return null;
    return {
      ok: true,
      mode: 'document_summary_source',
      title: map.page?.title || '',
      text: summary.text,
      plannedSectionCount: summary.numberedSectionCount,
      returnedSectionCount: summary.numberedSectionCount,
      failedSections: [],
      truncated: summary.truncated,
      readCoverage: summary.truncated ? 'partial' : 'complete',
      readStrategy: 'host_content_store',
      mapWasRebuilt: false,
      parallelReadsUsed: false,
    };
  }
  if (anchor.kind === 'numbered_section' && Number.isFinite(Number(anchor.ordinal))) {
    const section = sectionFromBlocks(blocks, anchor.ordinal, { maxChars: args.maxChars });
    if (!section) return null;
    return {
      ok: true,
      mode: 'target',
      ordinal: Number(anchor.ordinal),
      label: anchor.label || '',
      text: section.text,
      truncated: section.truncated,
      readCoverage: 'complete',
      readStrategy: 'host_content_store',
      mapWasRebuilt: false,
    };
  }
  return null;
}

async function handleBrowserRead(args = {}) {
  if (args.refresh === true) return mapError('explicit_refresh_requires_browser_map', { message: 'browser_read never refreshes a map.' });
  const existing = await getExistingNavigationMap(args);
  if (!existing?.ok) return textResult(JSON.stringify(existing, null, 2));
  const map = existing.map;
  let anchor = mapEngine.resolve(map, args.locator || args.id);
  if (!anchor && args.query) {
    const located = mapEngine.locate(map, args.query, { types: args.types, limit: 1 });
    anchor = located.matches?.[0] ? mapEngine.resolve(map, located.matches[0].id) : null;
  }
  if (!anchor) return mapError('target_not_found', { mapHandle: map.mapHandle, query: args.query || null, locator: args.locator || args.id || null, coverage: 'anchors_only' });
  const taskId = args.taskId || null;
  const ledgerKey = taskLedger.key(map.pageKey, anchor.id, { mode: args.mode, maxChars: args.maxChars });
  const cached = taskLedger.get(taskId, ledgerKey);
  if (cached) return textResult(JSON.stringify({ ...cached, duplicateReadSuppressed: true }, null, 2));
  // Content-store fast path: body text persisted at build time is served from
  // local disk — zero page interaction, works across restarts. Falls through
  // to the live read when the store is missing or the anchor is unsupported.
  const served = serveReadFromContentStore(map, anchor, args);
  if (served) {
    if (taskId) taskLedger.put(taskId, ledgerKey, served);
    return textResult(JSON.stringify(served, null, 2));
  }
  const readPlan = anchor.kind === 'document'
    ? {
        sections: (map.anchors || [])
          .filter((item) => ['numbered_section', 'document_section'].includes(item.kind))
          .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
          .map((item) => ({
            id: item.id,
            locator: item.locator,
            kind: item.kind,
            label: item.label,
            ordinal: item.ordinal ?? null,
            parentId: item.parentId || null,
            order: item.order,
            adapter: item.adapter || map.adapter,
            frameId: item.frameId || 0,
            locatorEvidence: item.locatorEvidence || {},
            range: item.range || null,
            flags: item.flags || {},
          })),
        images: (map.anchors || [])
          .filter((item) => item.kind === 'image')
          .map((item) => ({ id: item.id, parentId: item.parentId || null, locator: item.locator, adapter: item.adapter || map.adapter })),
        tables: (map.anchors || [])
          .filter((item) => item.kind === 'table')
          .map((item) => ({ id: item.id, parentId: item.parentId || null, locator: item.locator, adapter: item.adapter || map.adapter })),
      }
    : null;
  const result = await rawInternalExtension(INTERNAL_READ_TARGET_TOOL, {
    tabId: existing.page.tabId,
    page: map.page,
    adapter: anchor.adapter || map.adapter,
    anchor,
    readPlan,
    mode: args.mode || (anchor.kind === 'document' ? 'document_summary_source' : 'target'),
    maxChars: Math.max(500, Math.min(250000, Number(args.maxChars || 60000))),
    maxNodes: Math.max(1, Math.min(1000, Number(args.maxNodes || 200))),
    depth: Math.max(0, Math.min(8, Number(args.depth || 3))),
  });
  const response = {
    ...result,
    mapHandle: map.mapHandle,
    pageKey: map.pageKey,
    anchor: { id: anchor.id, locator: anchor.locator, kind: anchor.kind, label: anchor.label, ordinal: anchor.ordinal },
  };
  // Captured page image: hand it to the model as a native image block; keep the
  // huge base64 out of the JSON text (and out of the dedup ledger).
  if (response.image?.base64) {
    const image = response.image;
    const summary = { ...response, image: { source: image.source || 'unknown', mimeType: image.mimeType || 'image/png', width: image.width ?? null, height: image.height ?? null, degraded: image.degraded === true, delivered: 'image_block' } };
    if (result?.ok) taskLedger.put(taskId, ledgerKey, { ...summary, duplicateReadSuppressed: true });
    return imageResult(JSON.stringify(summary, null, 2), image);
  }
  if (result?.ok) taskLedger.put(taskId, ledgerKey, response);
  return textResult(JSON.stringify(response, null, 2));
}

async function handleBrowserAct(args = {}) {
  if (args.refresh === true) return mapError('explicit_refresh_requires_browser_map', { message: 'browser_act never refreshes a map.' });
  const existing = await getExistingNavigationMap(args);
  if (!existing?.ok) return textResult(JSON.stringify(existing, null, 2));
  const map = existing.map;
  let anchor = mapEngine.resolve(map, args.locator || args.id);
  if (!anchor && args.query) {
    const located = mapEngine.locate(map, args.query, { limit: 1 });
    anchor = located.matches?.[0] ? mapEngine.resolve(map, located.matches[0].id) : null;
  }
  if (!anchor) return mapError('target_not_found', { mapHandle: map.mapHandle });
  const action = String(args.action || 'scroll_into_view');
  if (['click','input','select','submit'].includes(action) && args.confirmed !== true) {
    return mapError('action_confirmation_required', { action, mapHandle: map.mapHandle, target: { id: anchor.id, locator: anchor.locator, label: anchor.label } });
  }
  const result = await rawInternalExtension(INTERNAL_ACT_TARGET_TOOL, {
    tabId: existing.page.tabId,
    page: map.page,
    adapter: map.adapter,
    anchor,
    action,
    value: args.value,
    confirmed: args.confirmed === true,
  });
  return textResult(JSON.stringify({ ...result, mapHandle: map.mapHandle, pageKey: map.pageKey }, null, 2));
}

const larkIndexManager = new LarkIndexManager();
const pageContextManager = new PageContextManager({ implicitIdleMs: 20000 });
let larkDocumentSession = null;
const larkFallbackLocks = new Map();
try { larkIndexManager.cleanupExpired(); } catch {}
const PAGE_BOUND_TOOLS = new Set(['browser_map','browser_locate','browser_read','browser_act']);
const LARK_PAGE_TOOLS = new Set();
function isLarkUrl(value) { return /(?:larksuite|feishu)\.com/i.test(String(value || '')); }
const LARK_UNSTRUCTURED_FALLBACK_TOOLS = new Set(['get_page_text','read_page','find','javascript_tool','navigate']);
const LARK_TRANSPORT_FAILURE_CODES = new Set(['browser_session_recovery_exhausted','browser_transport_unavailable','frame_session_expired','frame_session_chunk_failed','lark_document_not_found_in_frames']);
function isLarkTransportFailure(value) {
  const code = String(value?.code || value?.detail?.code || '');
  const error = String(value?.error || value?.detail?.error || '');
  return LARK_TRANSPORT_FAILURE_CODES.has(code) || /transport|disconnected|context invalidated|frame.*removed|message port closed|receiving end/i.test(error);
}
function cleanupLarkFallbackLocks() {
  const now = Date.now();
  for (const [key, value] of larkFallbackLocks) if (!value || value.expiresAt <= now) larkFallbackLocks.delete(key);
}
function fallbackLockKeys(identity, taskId = null) {
  const keys = [];
  if (taskId) keys.push(`task:${taskId}`);
  if (identity?.tabId) keys.push(`tab:${identity.tabId}`);
  if (identity?.url) keys.push(`url:${identity.url}`);
  return keys;
}
async function setLarkFallbackLock(identity, failure) {
  cleanupLarkFallbackLocks();
  let taskId = null;
  try { taskId = (await resolveUiBoundTarget({}))?.taskId || null; } catch {}
  const value = {
    code: failure?.code || 'structured_lark_read_failed',
    detail: failure?.coverage || failure?.scan || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + (taskId ? 10 * 60_000 : 90_000),
  };
  for (const key of fallbackLockKeys(identity, taskId)) larkFallbackLocks.set(key, value);
  return value;
}
async function clearLarkFallbackLock(identity) {
  cleanupLarkFallbackLocks();
  let taskId = null;
  try { taskId = (await resolveUiBoundTarget({}))?.taskId || null; } catch {}
  for (const key of fallbackLockKeys(identity, taskId)) larkFallbackLocks.delete(key);
}
function getLarkFallbackLock(resolved) {
  cleanupLarkFallbackLocks();
  for (const key of fallbackLockKeys(resolved?.identity, resolved?.taskId)) {
    const lock = larkFallbackLocks.get(key);
    if (lock) return lock;
  }
  return null;
}
function shouldBlockLarkFallback(tool, args, resolved) {
  if (!resolved?.ok || !isLarkUrl(resolved.identity?.url)) return null;
  const lock = getLarkFallbackLock(resolved);
  if (!lock) return null;
  const computerBlocked = tool === 'computer' && ['screenshot','scroll','scroll_to','key','type','left_click','double_click','triple_click'].includes(String(args?.action || ''));
  if (!LARK_UNSTRUCTURED_FALLBACK_TOOLS.has(tool) && !computerBlocked) return null;
  return {
    ok: false,
    code: 'lark_unstructured_fallback_blocked',
    structuredFailure: lock.code,
    target: resolved.identity,
    fallbackAllowed: false,
    structuredReadRequired: true,
    recommendedTool: 'lark_document_summary',
    message: 'A structured Lark read failed or had incomplete body coverage in this task. Generic page text, screenshots, navigation, and manual scrolling are blocked so partial content cannot be presented as a complete document summary.',
  };
}
async function captureBrowserPage(options = {}) {
  return rawInternalPageContext({ action: options.list ? 'list' : 'capture', tabId: options.tabId });
}
async function resolveUiBoundTarget(args = {}) {
  const ui = await rawInternalPageContext({ action: 'task_for_tool', tabId: args.tabId, pageAlias: args.pageAlias, pageId: args.pageId, pageQuery: args.pageQuery });
  if (ui?.ok && ui.identity?.tabId) return { ok: true, source: ui.source || 'ui_task', taskId: ui.task?.id || null, identity: ui.identity };
  if (['task_cancelled','task_paused_page_changed','target_page_changed','target_origin_changed'].includes(ui?.code)) return ui;
  if (ui?.code === 'ui_task_missing') return null;
  return ui?.ok === false ? ui : null;
}
async function resolveBrowserTarget(args = {}) {
  const ui = await resolveUiBoundTarget(args);
  if (ui) return ui;
  if (args.tabId) {
    const identity = await captureBrowserPage({ tabId: args.tabId });
    return identity?.ok ? { ok: true, source: 'explicit_tab', identity } : identity;
  }
  const current = pageContextManager.current();
  if (current) return pageContextManager.resolve(captureBrowserPage, { taskId: current.id, autoStart: false });
  return pageContextManager.resolve(captureBrowserPage, { autoStart: true });
}
async function resolveLarkBrowserTarget(args = {}) {
  const hasExplicitTarget = Boolean(args.tabId || args.pageAlias || args.pageId || args.pageQuery);
  if (hasExplicitTarget) {
    const explicit = await resolveBrowserTarget(args);
    if (!explicit?.ok) return explicit;
    if (!isLarkUrl(explicit.identity?.url)) {
      return { ok: false, code: 'explicit_target_not_lark_document', target: explicit.identity, retryable: false };
    }
    return explicit;
  }
  const bound = await resolveUiBoundTarget({});
  if (bound?.ok && isLarkUrl(bound.identity?.url)) return bound;
  const discovered = await rawExtensionJson('lark_document_identity', {
    autoDiscover: true,
    preferredTitle: args.documentTitle || args.title || null,
  });
  if (discovered?.ok && discovered.tabId) {
    return { ok: true, source: discovered.selectionReason || 'auto_discovered_lark_tab', identity: discovered };
  }
  if (discovered?.code === 'multiple_lark_documents') return discovered;
  if (bound && ['task_cancelled','task_paused_page_changed','target_page_changed','target_origin_changed'].includes(bound.code)) return bound;
  return discovered || { ok: false, code: 'lark_document_not_found', retryable: false };
}
async function prepareBrowserToolArgs(tool, args = {}) {
  if (!PAGE_BOUND_TOOLS.has(tool)) return { ok: true, args };
  const resolved = LARK_PAGE_TOOLS.has(tool)
    ? await resolveLarkBrowserTarget(args)
    : await resolveBrowserTarget(args);
  if (!resolved?.ok) return resolved;
  const fallbackBlock = shouldBlockLarkFallback(tool, args, resolved);
  if (fallbackBlock) return fallbackBlock;
  return { ok: true, args: { ...args, tabId: resolved.identity.tabId }, targetSource: resolved.source, pageContext: resolved.context || null, taskId: resolved.taskId || null };
}
async function callTool(tool, args = {}) {
  try {
    const prepared = await prepareBrowserToolArgs(tool, args);
    if (!prepared.ok) return textResult(JSON.stringify(prepared, null, 2));
    const result = await sendToExtension(tool, prepared.args);
    if (result?.content) return result;
    return textResult(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (error) { return textResult(JSON.stringify({ ok: false, code: error?.code || 'browser_tool_transport_error', error: error?.message || String(error), connection: getSidebarConnectionStatus() }, null, 2)); }
}
async function callExtensionJson(tool, args = {}) {
  const prepared = await prepareBrowserToolArgs(tool, args);
  if (!prepared.ok) return prepared;
  const result = await rawExtensionJson(tool, prepared.args);
  return result && typeof result === 'object' && !Array.isArray(result)
    ? { ...result, taskPage: prepared.pageContext || undefined, targetSource: prepared.targetSource }
    : result;
}
async function currentLarkIdentity(options = {}) {
  if (typeof options === 'number') options = { tabId: options };
  return callExtensionJson('lark_document_identity', {
    tabId: options.tabId,
    pageAlias: options.pageAlias,
    pageId: options.pageId,
    pageQuery: options.pageQuery,
    documentTitle: options.documentTitle,
    preferredTitle: options.documentTitle || options.preferredTitle,
    autoDiscover: options.autoDiscover !== false,
  });
}
async function locateCurrentLarkTarget(options = {}) {
  let targetHint = null;
  let index = { exists: false, indexedAt: null, hintFound: false, targetOrdinal: null };
  if (options.useIndex !== false) {
    const identity = await currentLarkIdentity(options);
    let loaded = null;
    if (identity?.ok && larkDocumentSession?.indexPath && larkDocumentSession.documentUrl === identity.url) {
      loaded = larkIndexManager.readIndexPath(larkDocumentSession.indexPath, { touch: true });
    }
    if (!loaded && identity?.ok) loaded = larkIndexManager.readIndexByUrl(identity.url, { touch: true });
    if (loaded?.index) {
      const hinted = larkIndexManager.locateHint(loaded.index, options.query, { windowRadius: 100 });
      if (hinted?.found) targetHint = hinted.targetHint;
      index = { exists: true, indexedAt: loaded.index.indexedAt, indexPath: loaded.indexPath, hintFound: hinted?.found === true, targetOrdinal: hinted?.targetHint?.ordinal ?? null };
    }
  }
  return { ...(await callExtensionJson('lark_locate', { ...options, targetHint })), index };
}
async function refreshCurrentLarkIndex(options = {}) {
  const cleanup = larkIndexManager.cleanupExpired();
  const identity = await currentLarkIdentity(options);
  if (!identity?.ok) return { ...identity, cleanup, structuredReadRequired: true, fallbackAllowed: false };
  const targetOptions = { ...options, tabId: identity.tabId };
  const map = await callExtensionJson('lark_deep_read', { scope: 'map', tabId: identity.tabId, pageAlias: options.pageAlias, refresh: true, maxBlocks: options.maxBlocks || 10000, maxSteps: options.maxSteps || 4000, maxTargets: 5, settleMs: 80 });
  if (!map?.ok) return { ok: false, code: map?.code || 'index_map_failed', detail: map, identity, cleanup, structuredReadRequired: true, fallbackAllowed: false };
  if (map.scan?.complete !== true) return { ok: false, code: 'source_scan_incomplete', scan: map.scan, identity, doNotReplaceExistingIndex: true, cleanup, structuredReadRequired: true, fallbackAllowed: false };
  const blockCount = Number(map.blockCount || 0);
  if (!Number.isInteger(blockCount) || blockCount <= 0) {
    return { ok: false, code: 'source_scan_empty', blockCount, scan: map.scan, identity, doNotReplaceExistingIndex: true, cleanup, structuredReadRequired: true, fallbackAllowed: false };
  }
  const blocks = [], chunkSize = Math.max(50, Math.min(250, Number(options.chunkSize || 200)));
  for (let startOrdinal = 0; startOrdinal < blockCount; startOrdinal += chunkSize) {
    const endOrdinal = Math.min(blockCount - 1, startOrdinal + chunkSize - 1);
    const range = await callExtensionJson('lark_deep_read', { scope: 'range', tabId: identity.tabId, pageAlias: options.pageAlias, startOrdinal, endOrdinal, maxReturnBlocks: chunkSize, maxBlocks: options.maxBlocks || 10000, refresh: false });
    if (!range?.ok || !Array.isArray(range.blocks)) return { ok: false, code: 'index_range_failed', failedRange: { startOrdinal, endOrdinal }, detail: range, identity, doNotReplaceExistingIndex: true, cleanup, structuredReadRequired: true, fallbackAllowed: false };
    blocks.push(...range.blocks);
  }
  if (blocks.length !== blockCount || blocks.length <= 0) return { ok: false, code: blocks.length <= 0 ? 'source_scan_empty' : 'index_block_count_mismatch', expectedBlockCount: blockCount, actualBlockCount: blocks.length, identity, doNotReplaceExistingIndex: true, cleanup, structuredReadRequired: true, fallbackAllowed: false };
  const candidateCoverage = analyzeDocumentCoverage({ entries: blocks, sections: map.sections || [], scan: map.scan, blockCount });
  if (!candidateCoverage.complete) {
    const failure = { ok: false, code: 'structured_body_incomplete', coverage: candidateCoverage, identity, doNotReplaceExistingIndex: true, cleanup, structuredReadRequired: true, fallbackAllowed: false };
    await setLarkFallbackLock(identity, failure);
    return failure;
  }
  const saved = larkIndexManager.writeIndex({ documentName: map.title || identity.title, documentUrl: map.url || identity.url, documentType: map.scan?.documentType || 'rich_doc', blockCount, scan: map.scan, sections: map.sections || [], blocks });
  larkDocumentSession = { mode: options.sessionMode || 'new', indexPath: saved.indexPath, documentName: saved.index.documentName, documentUrl: saved.index.documentUrl, indexedAt: saved.index.indexedAt };
  return { ok: true, action: 'index_refreshed', ...larkDocumentSession, target: identity, lastOpenedAt: saved.index.lastOpenedAt, blockCount: saved.index.blockCount, indexedBlockCount: saved.index.indexedBlockCount, sectionCount: saved.index.sectionCount, sourceComplete: saved.index.scan?.complete === true, cleanup };
}
async function startLarkDocumentSession(options = {}) {
  const modeValue = options.mode === 'history' ? 'history' : 'new';
  if (modeValue === 'new') return refreshCurrentLarkIndex({ ...options, sessionMode: 'new' });
  const identity = await currentLarkIdentity(options);
  if (!identity?.ok) return identity;
  const loaded = larkIndexManager.readIndexByUrl(identity.url, { touch: true });
  if (!loaded) return { ok: true, action: 'history_index_missing', sessionMode: 'history', documentName: identity.title, documentUrl: identity.url, indexExists: false };
  larkDocumentSession = { mode: 'history', indexPath: loaded.indexPath, documentName: loaded.index.documentName, documentUrl: loaded.index.documentUrl, indexedAt: loaded.index.indexedAt };
  return { ok: true, action: 'history_index_loaded', sessionMode: 'history', indexExists: true, ...larkDocumentSession, blockCount: loaded.index.blockCount, sectionCount: loaded.index.sectionCount };
}
async function ensureLarkQuerySession(options = {}) {
  const identity = await currentLarkIdentity(options);
  if (!identity?.ok) return identity;
  if (options.refresh) {
    const refreshed = await refreshCurrentLarkIndex({ ...options, tabId: identity.tabId });
    return refreshed.ok ? { ok: true, loaded: larkIndexManager.readIndexPath(refreshed.indexPath, { touch: true }), identity } : refreshed;
  }
  if (larkDocumentSession?.indexPath && larkDocumentSession.documentUrl === identity.url) {
    const loaded = larkIndexManager.readIndexPath(larkDocumentSession.indexPath, { touch: true });
    if (loaded) return { ok: true, loaded, identity };
  }
  const loaded = larkIndexManager.readIndexByUrl(identity.url, { touch: true });
  if (!loaded) return { ok: false, code: 'index_missing', documentName: identity.title, documentUrl: identity.url, fallbackAllowed: false };
  larkDocumentSession = { mode: options.sessionMode || 'history', indexPath: loaded.indexPath, documentName: loaded.index.documentName, documentUrl: loaded.index.documentUrl, indexedAt: loaded.index.indexedAt };
  return { ok: true, loaded, identity };
}

async function ensureCompleteLarkIndex(options = {}) {
  const identity = await currentLarkIdentity(options);
  if (!identity?.ok) return identity;
  const existing = larkIndexManager.readIndexByUrl(identity.url, { touch: true });
  const existingCoverage = existing?.index ? analyzeDocumentCoverage(existing.index, options) : null;
  const isComplete = existing?.index?.scan?.complete === true && Number(existing.index.indexedBlockCount || 0) > 0 && existingCoverage?.complete === true;
  if (isComplete && options.refresh !== true) {
    larkDocumentSession = { mode: 'history', indexPath: existing.indexPath, documentName: existing.index.documentName, documentUrl: existing.index.documentUrl, indexedAt: existing.index.indexedAt };
    return { ok: true, loaded: existing, identity, refreshed: false };
  }
  const refreshed = await refreshCurrentLarkIndex({ ...options, tabId: identity.tabId, sessionMode: 'new' });
  if (!refreshed?.ok) {
    const transportFailure = isLarkTransportFailure(refreshed);
    const failure = { ...refreshed, identity, structuredReadRequired: true, fallbackAllowed: false, transportFailure, recoveryExhausted: transportFailure };
    // Transport failures are retried and restored inside Browser Session. Do not
    // create a global page lock for them: a later structured retry may succeed.
    if (!transportFailure) await setLarkFallbackLock(identity, failure);
    return failure;
  }
  const loaded = larkIndexManager.readIndexPath(refreshed.indexPath, { touch: true });
  const refreshedCoverage = loaded?.index ? analyzeDocumentCoverage(loaded.index, options) : null;
  if (!loaded?.index || loaded.index.scan?.complete !== true || Number(loaded.index.indexedBlockCount || 0) <= 0 || refreshedCoverage?.complete !== true) {
    const failure = { ok: false, code: refreshedCoverage && !refreshedCoverage.complete ? 'structured_body_incomplete' : 'complete_lark_index_unavailable', identity, refreshed, coverage: refreshedCoverage, structuredReadRequired: true, fallbackAllowed: false };
    await setLarkFallbackLock(identity, failure);
    return failure;
  }
  await clearLarkFallbackLock(identity);
  return { ok: true, loaded, identity, refreshed: true, coverage: refreshedCoverage };
}
async function summarizeLarkDocument(options = {}) {
  const session = await ensureCompleteLarkIndex(options);
  if (!session?.ok) return session;
  const context = buildDocumentSummaryContext(session.loaded.index, options);
  if (!context?.ok) {
    await setLarkFallbackLock(session.identity, context);
    return { ...context, indexPath: session.loaded.indexPath, target: session.identity, refreshed: session.refreshed, fallbackAllowed: false };
  }
  await clearLarkFallbackLock(session.identity);
  return {
    ...context,
    indexPath: session.loaded.indexPath,
    target: session.identity,
    refreshed: session.refreshed,
    fallbackAllowed: false,
  };
}
async function readLarkRequirement(options = {}) {
  const session = await ensureCompleteLarkIndex(options);
  if (!session?.ok) return session;
  const result = findNumberedRequirement(session.loaded.index, options.requirementNumber, options);
  return {
    ...result,
    indexPath: session.loaded.indexPath,
    target: session.identity,
    refreshed: session.refreshed,
    fallbackAllowed: false,
    inferenceForbidden: true,
  };
}
async function larkSessionCompatibility(options = {}) {
  const action = String(options.action || options.mode || 'start').toLowerCase();
  if (['status','inspect'].includes(action)) {
    const identity = await currentLarkIdentity(options);
    if (!identity?.ok) return identity;
    const loaded = larkIndexManager.readIndexByUrl(identity.url, { touch: true });
    return loaded ? { ok: true, action: 'status', identity, indexExists: true, indexPath: loaded.indexPath, indexedAt: loaded.index.indexedAt, blockCount: loaded.index.blockCount, indexedBlockCount: loaded.index.indexedBlockCount, sourceComplete: loaded.index.scan?.complete === true } : { ok: true, action: 'status', identity, indexExists: false };
  }
  if (['refresh','rebuild'].includes(action)) return refreshCurrentLarkIndex(options);
  return startLarkDocumentSession({ ...options, mode: action === 'history' ? 'history' : 'new' });
}

const server = new McpServer({ name: 'claude-sidebar-pure-map', version: VERSION });
function reg(name, description, schema, handler) { server.tool(name, description, schema, handler); }
const optionalTab = z.number().optional();

// Pure Map Runtime contract: these are the only model-visible browser tools.
// Document/Lark, virtual-scroll, table/grid, spreadsheet, Figma/canvas and
// structured-data engines remain internal adapters behind this interface.
reg('browser_map',
  'Get or create the persistent sparse navigation map for one browser page. A page map is built once and reused across conversations and restarts. Set refresh=true only when the user explicitly asks to refresh the map. Returns a compact map handle and capability summary; the full map never enters model context.',
  {
    tabId: optionalTab,
    pageAlias: z.string().optional(),
    pageId: z.string().optional(),
    pageQuery: z.string().optional(),
    refresh: z.boolean().optional(),
    maxFrames: z.number().optional(),
    maxNodesPerFrame: z.number().optional(),
    maxAxNodes: z.number().optional(),
    maxBlocks: z.number().optional(),
    chunkSize: z.number().optional(),
  },
  (args) => handleBrowserMap(args),
);

reg('browser_locate',
  'Locate anchors in an existing persistent navigation map. This is a local index query: it never scans the page, rebuilds the map, or returns the full index. Returns at most five compact candidates.',
  {
    query: z.string().optional(),
    locator: z.string().optional(),
    id: z.string().optional(),
    tabId: optionalTab,
    pageAlias: z.string().optional(),
    pageId: z.string().optional(),
    pageQuery: z.string().optional(),
    types: z.array(z.string()).optional(),
    limit: z.number().optional(),
    caseSensitive: z.boolean().optional(),
  },
  (args) => handleBrowserLocate(args),
);

reg('browser_read',
  'Read live content for one anchor from an existing persistent navigation map. The map is not rebuilt. For document roots, the adapter creates a one-pass read plan; for individual anchors, only the target range is materialized.',
  {
    locator: z.string().optional(),
    id: z.string().optional(),
    query: z.string().optional(),
    tabId: optionalTab,
    pageAlias: z.string().optional(),
    pageId: z.string().optional(),
    pageQuery: z.string().optional(),
    types: z.array(z.string()).optional(),
    depth: z.number().optional(),
    maxNodes: z.number().optional(),
    maxChars: z.number().optional(),
    taskId: z.string().optional(),
    mode: z.enum(['target', 'document_summary_source', 'text_only', 'content_critical_images', 'all_visual_content']).optional(),
  },
  (args) => handleBrowserRead(args),
);

reg('browser_act',
  'Act on a stable anchor from an existing persistent navigation map. The map is never rebuilt. Safe navigation actions are allowed directly; click/input/select/submit require confirmed=true.',
  {
    locator: z.string().optional(),
    id: z.string().optional(),
    query: z.string().optional(),
    tabId: optionalTab,
    pageAlias: z.string().optional(),
    pageId: z.string().optional(),
    pageQuery: z.string().optional(),
    action: z.enum(['scroll_into_view', 'focus', 'click', 'input', 'select', 'submit']),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    confirmed: z.boolean().optional(),
  },
  (args) => handleBrowserAct(args),
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`Claude Sidebar MCP v${VERSION} ready (${mode})\n`);
