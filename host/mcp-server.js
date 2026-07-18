#!/usr/bin/env node

// MCP Server for Open Claude in Chrome extension.
// Started by Claude Code via stdio MCP transport.
//
// Operates in one of two modes:
// - PRIMARY: Owns the TCP port, accepts native host + client connections
// - CLIENT: Port already taken by another session, connects as a client
//
// This allows multiple Claude Code sessions to share one browser extension.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { PageContextManager } from "./page-context/page-context-manager.mjs";
import { LarkIndexManager } from "./lark-index/lark-index-manager.mjs";
import { CapabilityRegistry } from "./capability-registry.js";
import { registerLarkAdapter } from "./lark-adapter.js";


const DEFAULT_PORT = 18765;

function getPort() {
  const configPath = path.join(os.homedir(), ".config", "open-claude-in-chrome", "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.port || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

const TCP_PORT = getPort();

const BROWSER_IMAGE_MODE = process.env.CLAUDE_SIDEBAR_IMAGE_MODE || "mcp-image";

function textContentOf(result) {
  if (!result?.content || !Array.isArray(result.content)) return "";
  return result.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function hasImageContent(result) {
  return Boolean(result?.content?.some((part) => part?.type === "image"));
}

async function transformBrowserImageResult(toolName, args, result) {
  if (BROWSER_IMAGE_MODE === "mcp-image" || !hasImageContent(result)) {
    return result;
  }

  const originalText = textContentOf(result);
  let pageSnapshot = "";
  let layoutSnapshot = "";
  if (toolName === "computer" && Number.isFinite(Number(args?.tabId))) {
    const tabId = Number(args.tabId);
    try {
      const fallback = await sendToExtension("read_page", {
        tabId,
        depth: 6,
        max_chars: 24000,
      });
      pageSnapshot = textContentOf(fallback);
    } catch (error) {
      pageSnapshot = "Accessibility fallback failed: " + (error?.message || String(error));
    }

    try {
      const geometry = await sendToExtension("inspect_layout", {
        tabId,
        focus: "auto",
        detail: "summary",
        maxItems: 6,
        comparePrevious: true,
      });
      layoutSnapshot = textContentOf(geometry);
    } catch (error) {
      layoutSnapshot = "Layout geometry fallback failed: " + (error?.message || String(error));
    }
  }

  const modeNotice =
    "[Claude Sidebar safe screenshot mode]\n" +
    "Chrome completed the browser capture, but the MCP image content block was intentionally withheld from Claude Code on macOS to avoid the known Gatekeeper/native .node extraction failure. " +
    "The result below already includes accessibility and read-only DOM geometry. Do not retry screenshot in a loop and do not ask the user whether to measure DOM geometry. " +
    "For clipping, modal height, footer/button reachability, fixed/sticky occlusion, scroll traps, responsive overflow, and before/after verification, use the structured diagnosis directly or call inspect_layout automatically. Start with detail=summary; use detail=full or targetText only when more detail is needed.";

  return {
    content: [
      {
        type: "text",
        text: [
          originalText,
          modeNotice,
          pageSnapshot && ("Accessibility snapshot after browser action:\n" + pageSnapshot),
          layoutSnapshot && ("Layout geometry after browser action:\n" + layoutSnapshot),
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
  };
}

// --- Mode detection ---
// Try to bind the port. If it's taken, switch to client mode.
let mode = "primary"; // or "client"

// --- Shared state ---
let nativeHostSocket = null;
const pendingRequests = new Map(); // id -> { resolve, reject, timer, tool, args, resent }
let requestIdCounter = 0;

// Primary mode: track client MCP server connections
const clientSockets = new Map(); // clientId -> socket
let clientIdCounter = 0;
// Map from prefixed request ID -> { clientId, originalId }
const clientRequestMap = new Map();

// Client mode: TCP connection to the primary
let primarySocket = null;
let clientBuffer = Buffer.alloc(0);

let currentBrowserContext = null;
let capabilityRegistry = null;
const BROWSER_CONTEXT_FILE = process.env.CLAUDE_SIDEBAR_CONTEXT_FILE || (process.platform === "darwin"
  ? path.join(os.homedir(), "Library", "Application Support", "ClaudeSidebarHost", "browser-context.json")
  : path.join(os.homedir(), ".config", "claude-sidebar", "browser-context.json"));

function readPersistedBrowserContext() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BROWSER_CONTEXT_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function getEffectiveBrowserContext() {
  return readPersistedBrowserContext() || currentBrowserContext;
}

function applyBrowserContext(context) {
  currentBrowserContext = context || null;
  const changed = capabilityRegistry?.updateContext(currentBrowserContext) || [];
  if (changed.length > 0) {
    process.stderr.write(
      `Capability adapters changed: ${changed.map((item) => `${item.id}=${item.active ? "on" : "off"}`).join(", ")}\n`,
    );
  }
}

function broadcastBrowserContext(message) {
  const line = JSON.stringify(message) + "\n";
  for (const socket of clientSockets.values()) {
    if (!socket.destroyed) socket.write(line);
  }
}

// CLAUDE_SIDEBAR_V67_CONNECTION_RECOVERY
const CONNECTION_RECOVERY_WAIT_MS = 30000;
const CONNECTION_RECOVERY_POLL_MS = 100;
const RECOVERY_SAFE_TO_RETRY_TOOLS = new Set([
  "lark_document_identity",
  "lark_deep_read",
  "lark_locate",
  "lark_session_start",
  "lark_index_refresh",
  "lark_index_status",
  "lark_query",
  "lark_index_cleanup",
  "tabs_context_mcp",
  "browser_app_inspect",
  "browser_app_query",
]);
let connectionRecoveryState = "starting";
let connectionLastError = null;
let connectionStateChangedAt = Date.now();
let primaryReconnectTimer = null;
let primaryElectionTimer = null;
let primaryConnectInFlight = false;
let primaryRecoveryAttempt = 0;
let primaryConnectedAt = null;
let nativeHostConnectedAt = null;

function socketReady(socket) {
  return Boolean(socket && !socket.destroyed && socket.writable);
}

function setConnectionRecoveryState(state, error = null) {
  connectionRecoveryState = state;
  connectionLastError = error ? String(error) : null;
  connectionStateChangedAt = Date.now();
}

function getSidebarConnectionStatus() {
  return {
    ok: true,
    mode,
    recoveryState: connectionRecoveryState,
    primaryConnected: mode === "primary" ? Boolean(tcpServer?.listening) : socketReady(primarySocket),
    nativeHostConnected: mode === "primary" ? socketReady(nativeHostSocket) : null,
    primaryConnectedAt,
    nativeHostConnectedAt,
    lastError: connectionLastError,
    stateChangedAt: new Date(connectionStateChangedAt).toISOString(),
    pendingRequestCount: pendingRequests.size,
    connectedClientCount: clientSockets.size,
    recoveryAttempt: primaryRecoveryAttempt,
  };
}

function currentOutboundSocket() {
  return mode === "primary" ? nativeHostSocket : primarySocket;
}

function transportReady() {
  return socketReady(currentOutboundSocket());
}

function safeToRetryTool(tool) {
  return RECOVERY_SAFE_TO_RETRY_TOOLS.has(String(tool || ""));
}

function rejectPendingEntry(id, entry, error) {
  clearTimeout(entry.timer);
  pendingRequests.delete(id);
  try { entry.reject(error); } catch {}
}

function markPendingForRecovery(reason) {
  for (const [id, entry] of pendingRequests) {
    if (entry.inFlight && !safeToRetryTool(entry.tool)) {
      rejectPendingEntry(id, entry, new Error("Connection changed after dispatch; automatic retry is disabled for this tool."));
      continue;
    }
    entry.inFlight = false;
    entry.recoveryReason = reason || "transport_disconnected";
  }
}

function markForwardedClientRequestsForRecovery(reason) {
  for (const [prefixedId, info] of clientRequestMap) {
    if (!info.sent) continue;
    if (!safeToRetryTool(info.tool)) {
      const clientSocket = clientSockets.get(info.clientId);
      if (socketReady(clientSocket)) {
        clientSocket.write(JSON.stringify({
          id: info.originalId,
          type: "tool_error",
          error: "Connection changed after dispatch; automatic retry is disabled for this tool.",
          code: "unsafe_retry_blocked",
        }) + "\n");
      }
      clientRequestMap.delete(prefixedId);
      continue;
    }
    info.sent = false;
    info.recoveryReason = reason || "native_host_disconnected";
  }
}

function dispatchPendingEntry(id) {
  const entry = pendingRequests.get(id);
  const socket = currentOutboundSocket();
  if (!entry || entry.inFlight || !socketReady(socket)) return false;
  entry.inFlight = true;
  entry.dispatchCount = Number(entry.dispatchCount || 0) + 1;
  socket.write(JSON.stringify({ id, type: "tool_request", tool: entry.tool, args: entry.args }) + "\n");
  return true;
}

function cancelForwardedClientRequestsForClient(clientId, reason = "client_disconnected") {
  for (const [prefixedId, info] of clientRequestMap) {
    if (String(info.clientId) !== String(clientId)) continue;
    if (mode === "primary" && socketReady(nativeHostSocket)) {
      try {
        nativeHostSocket.write(JSON.stringify({ id: prefixedId, type: "tool_cancel", reason }) + "\n");
      } catch {}
    }
    clientRequestMap.delete(prefixedId);
  }
}

function dispatchForwardedClientRequests() {
  if (mode !== "primary" || !socketReady(nativeHostSocket)) return;
  for (const [prefixedId, info] of clientRequestMap) {
    if (info.sent) continue;
    const clientSocket = clientSockets.get(info.clientId);
    if (!socketReady(clientSocket)) {
      clientRequestMap.delete(prefixedId);
      continue;
    }
    info.sent = true;
    nativeHostSocket.write(JSON.stringify({
      id: prefixedId,
      type: "tool_request",
      tool: info.tool,
      args: info.args,
    }) + "\n");
  }
}

function dispatchAllPendingRequests() {
  if (!transportReady()) return;
  for (const id of pendingRequests.keys()) dispatchPendingEntry(id);
  dispatchForwardedClientRequests();
}

async function waitForExtensionTransport(timeoutMs = CONNECTION_RECOVERY_WAIT_MS) {
  const startedAt = Date.now();
  while (!transportReady()) {
    if (Date.now() - startedAt >= timeoutMs) {
      const status = getSidebarConnectionStatus();
      throw new Error("Browser transport did not recover within " + timeoutMs + "ms: " + JSON.stringify(status));
    }
    await new Promise((resolve) => setTimeout(resolve, CONNECTION_RECOVERY_POLL_MS));
  }
  return currentOutboundSocket();
}

async function forwardClientRequestWhenReady(socket, msg, prefixedId) {
  try {
    if (mode !== "primary" || !socketReady(nativeHostSocket)) {
      await waitForExtensionTransport(CONNECTION_RECOVERY_WAIT_MS);
    }
    const info = clientRequestMap.get(prefixedId);
    if (!info || !socketReady(socket) || !socketReady(nativeHostSocket)) return;
    if (!info.sent) {
      info.sent = true;
      nativeHostSocket.write(JSON.stringify({ ...msg, id: prefixedId }) + "\n");
    }
  } catch (error) {
    clientRequestMap.delete(prefixedId);
    if (socketReady(socket)) {
      socket.write(JSON.stringify({
        id: msg.id,
        type: "tool_error",
        error: String(error),
        code: "connection_recovery_timeout",
        retryable: true,
      }) + "\n");
    }
  }
}


// --- sendToExtension: works in both modes ---

async function waitForNativeHost(timeoutMs = 8000) {
  const startedAt = Date.now();
  while (!nativeHostSocket || nativeHostSocket.destroyed) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Browser extension is not connected after waiting for the native host.");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function sendToExtension(tool, args) {
  return new Promise((resolve, reject) => {
    const id = String(++requestIdCounter);
    // CLAUDE_SIDEBAR_V66_DEEP_READER_TIMEOUT
    const requestTimeoutMs = ["lark_session_start", "lark_index_refresh"].includes(tool) ? 300000 : (["lark_deep_read", "lark_locate", "lark_query", "browser_app_query"].includes(tool) ? 180000 : 60000);
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Tool request timed out after " + requestTimeoutMs + "ms"));
    }, requestTimeoutMs);
    pendingRequests.set(id, {
      resolve,
      reject,
      timer,
      tool,
      args,
      resent: false,
      inFlight: false,
      dispatchCount: 0,
    });

    (async () => {
      try {
        await waitForExtensionTransport(Math.min(CONNECTION_RECOVERY_WAIT_MS, Math.max(1000, requestTimeoutMs - 1000)));
        if (!dispatchPendingEntry(id)) {
          throw new Error("Transport recovered but the request could not be dispatched.");
        }
      } catch (error) {
        const entry = pendingRequests.get(id);
        if (entry) rejectPendingEntry(id, entry, error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

// --- Pidfile management ---

const pidfilePath = path.join(os.tmpdir(), `open-claude-in-chrome-mcp-${TCP_PORT}.pid`);

function writePidfile() {
  try { fs.writeFileSync(pidfilePath, String(process.pid)); } catch {}
}

function cleanupPidfile() {
  try {
    const content = fs.readFileSync(pidfilePath, "utf-8").trim();
    if (content === String(process.pid)) fs.unlinkSync(pidfilePath);
  } catch {}
}

function shutdown() {
  if (mode === "primary") cleanupPidfile();
  if (nativeHostSocket && !nativeHostSocket.destroyed) nativeHostSocket.destroy();
  if (primarySocket && !primarySocket.destroyed) primarySocket.destroy();
  for (const [, sock] of clientSockets) {
    if (!sock.destroyed) sock.destroy();
  }
  for (const [, { reject, timer }] of pendingRequests) {
    clearTimeout(timer);
    reject(new Error("Server shutting down"));
  }
  pendingRequests.clear();
  if (mode === "primary") tcpServer.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
process.stdin.on("end", shutdown);
process.stdin.resume();

// --- Primary mode: handle incoming TCP connections ---

function handleResponse(msg) {
  // Check if this response is for a client request (prefixed ID)
  if (msg.id && clientRequestMap.has(msg.id)) {
    const { clientId, originalId } = clientRequestMap.get(msg.id);
    clientRequestMap.delete(msg.id);
    const clientSocket = clientSockets.get(clientId);
    if (clientSocket && !clientSocket.destroyed) {
      const fwd = JSON.stringify({ ...msg, id: originalId }) + "\n";
      clientSocket.write(fwd);
    }
    return;
  }

  // Otherwise it's for a local request
  if (msg.id && pendingRequests.has(msg.id)) {
    const { resolve, reject, timer } = pendingRequests.get(msg.id);
    clearTimeout(timer);
    pendingRequests.delete(msg.id);
    if (msg.type === "tool_error") {
      reject(new Error(msg.error || "Tool execution failed"));
    } else {
      resolve(msg.result);
    }
  }
}

function processLine(line) {
  if (!line) return;
  try {
    const msg = JSON.parse(line);
    if (msg.type === "heartbeat") return;
    if (msg.type === "browser_context") {
      applyBrowserContext(msg.context);
      broadcastBrowserContext(msg);
      return;
    }
    handleResponse(msg);
  } catch {}
}

const tcpServer = net.createServer((socket) => {
  // Classification: wait briefly for a client_hello. If none arrives, treat as native host.
  // Native hosts (launched by the browser) don't send data immediately on connect.
  // Client MCP servers send client_hello immediately.
  let classified = false;
  let earlyBuffer = Buffer.alloc(0);

  const classifyTimeout = setTimeout(() => {
    if (!classified) {
      classified = true;
      setupNativeHostConnection(socket, earlyBuffer);
    }
  }, 500); // 500ms is plenty for a local client_hello

  socket.on("data", function onEarlyData(chunk) {
    if (classified) return; // Already classified, data handler was replaced
    earlyBuffer = Buffer.concat([earlyBuffer, chunk]);
    const newlineIdx = earlyBuffer.indexOf(10);
    if (newlineIdx === -1) return; // No full line yet, keep buffering

    const firstLine = earlyBuffer.subarray(0, newlineIdx).toString("utf-8").trim();
    try {
      const firstMsg = JSON.parse(firstLine);
      if (firstMsg.type === "client_hello") {
        classified = true;
        clearTimeout(classifyTimeout);
        socket.removeListener("data", onEarlyData);
        setupClientConnection(socket, earlyBuffer.subarray(newlineIdx + 1));
        return;
      }
    } catch {}

    // Got data but it's not a client_hello, this is a native host
    classified = true;
    clearTimeout(classifyTimeout);
    socket.removeListener("data", onEarlyData);
    setupNativeHostConnection(socket, earlyBuffer);
  });
});

function setupNativeHostConnection(socket, initialBuffer) {
  if (nativeHostSocket && !nativeHostSocket.destroyed) {
    // Already have a native host. Reject.
    socket.end(JSON.stringify({ type: "error", error: "Another browser profile is already connected." }) + "\n");
    socket.destroy();
    return;
  }

  nativeHostSocket = socket;
  // CLAUDE_SIDEBAR_NATIVE_CONNECTED
  nativeHostConnectedAt = new Date().toISOString();
  setConnectionRecoveryState("connected");
  dispatchAllPendingRequests();
  let buffer = initialBuffer;

  // Process any data already in the buffer
  let idx;
  while ((idx = buffer.indexOf(10)) !== -1) {
    processLine(buffer.subarray(0, idx).toString("utf-8").trim());
    buffer = buffer.subarray(idx + 1);
  }

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf(10)) !== -1) {
      processLine(buffer.subarray(0, newlineIdx).toString("utf-8").trim());
      buffer = buffer.subarray(newlineIdx + 1);
    }
  });

  // CLAUDE_SIDEBAR_NATIVE_RECOVERY_HANDLERS
  dispatchAllPendingRequests();

  socket.on("error", (error) => {
    if (nativeHostSocket === socket) nativeHostSocket = null;
    setConnectionRecoveryState("waiting_for_native_host", error?.message || "native_host_error");
  });

  socket.on("close", () => {
    if (nativeHostSocket === socket) nativeHostSocket = null;
    markPendingForRecovery("native_host_disconnected");
    markForwardedClientRequestsForRecovery("native_host_disconnected");
    setConnectionRecoveryState("waiting_for_native_host", "native_host_disconnected");
  });}

function setupClientConnection(socket, initialBuffer) {
  const clientId = String(++clientIdCounter);
  clientSockets.set(clientId, socket);
  process.stderr.write(`Client MCP server connected (client ${clientId})\n`);

  // Send ack
  socket.write(JSON.stringify({ type: "client_ack", clientId }) + "\n");
  if (currentBrowserContext) {
    socket.write(JSON.stringify({ type: "browser_context", context: currentBrowserContext }) + "\n");
  }

  let buffer = initialBuffer;

  function processClientData() {
    let idx;
    while ((idx = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, idx).toString("utf-8").trim();
      buffer = buffer.subarray(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "tool_request" && msg.id) {
          // Forward to native host with a prefixed ID
          const prefixedId = `c${clientId}_${msg.id}`;
          clientRequestMap.set(prefixedId, { clientId, originalId: msg.id, tool: msg.tool, args: msg.args, sent: false });

          forwardClientRequestWhenReady(socket, msg, prefixedId);
        }
      } catch {}
    }
  }

  // Process initial buffer
  processClientData();

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    processClientData();
  });

  socket.on("error", () => {});
  socket.on("close", () => {
    cancelForwardedClientRequestsForClient(clientId, "mcp_client_closed");
    clientSockets.delete(clientId);
  });
}

// --- Client mode: connect to primary ---

// CLAUDE_SIDEBAR_V67_CLIENT_FAILOVER
function clearClientRecoveryTimers() {
  if (primaryReconnectTimer) clearTimeout(primaryReconnectTimer);
  if (primaryElectionTimer) clearTimeout(primaryElectionTimer);
  primaryReconnectTimer = null;
  primaryElectionTimer = null;
}

function attachPrimaryClientSocket(socket) {
  primarySocket = socket;
  clientBuffer = Buffer.alloc(0);
  mode = "client";
  primaryConnectInFlight = false;
  primaryRecoveryAttempt = 0;
  primaryConnectedAt = new Date().toISOString();
  setConnectionRecoveryState("connected");
  process.stderr.write("Connected to primary MCP server on :" + TCP_PORT + "\n");
  socket.write(JSON.stringify({ type: "client_hello" }) + "\n");

  socket.on("data", (chunk) => {
    clientBuffer = Buffer.concat([clientBuffer, chunk]);
    let idx;
    while ((idx = clientBuffer.indexOf(10)) !== -1) {
      const line = clientBuffer.subarray(0, idx).toString("utf-8").trim();
      clientBuffer = clientBuffer.subarray(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "client_ack") continue;
        if (msg.type === "error") {
          process.stderr.write("Primary server error: " + msg.error + "\n");
          continue;
        }
        if (msg.id && pendingRequests.has(msg.id)) {
          const { resolve, reject, timer } = pendingRequests.get(msg.id);
          clearTimeout(timer);
          pendingRequests.delete(msg.id);
          if (msg.type === "tool_error") reject(new Error(msg.error || "Tool execution failed"));
          else resolve(msg.result);
        }
      } catch {}
    }
  });

  socket.on("error", (error) => {
    connectionLastError = error?.message || String(error);
  });

  socket.on("close", () => {
    if (primarySocket === socket) primarySocket = null;
    markPendingForRecovery("primary_disconnected");
    setConnectionRecoveryState("recovering_primary", "primary_disconnected");
    scheduleClientRecovery("primary_disconnected");
  });

  dispatchAllPendingRequests();
}

function scheduleClientRecovery(reason, delayOverride) {
  if (mode === "primary" || socketReady(primarySocket) || primaryReconnectTimer || primaryElectionTimer) return;
  primaryRecoveryAttempt += 1;
  setConnectionRecoveryState("recovering_primary", reason || "primary_unavailable");
  const delay = Number.isFinite(delayOverride)
    ? Math.max(0, delayOverride)
    : 200 + Math.floor(Math.random() * 600);
  primaryReconnectTimer = setTimeout(() => {
    primaryReconnectTimer = null;
    connectToPrimaryOrPromote();
  }, delay);
}

function connectToPrimaryOrPromote() {
  if (mode === "primary" || socketReady(primarySocket) || primaryConnectInFlight) return;
  primaryConnectInFlight = true;
  setConnectionRecoveryState("connecting_to_primary");
  const socket = net.createConnection(TCP_PORT, "127.0.0.1");
  let settled = false;
  const connectTimer = setTimeout(() => {
    failInitialConnect(new Error("primary_connect_timeout"));
  }, 1000);

  const onConnect = () => {
    if (settled) return;
    settled = true;
    clearTimeout(connectTimer);
    socket.removeListener("error", failInitialConnect);
    attachPrimaryClientSocket(socket);
  };
  function failInitialConnect(error) {
    if (settled) return;
    settled = true;
    clearTimeout(connectTimer);
    primaryConnectInFlight = false;
    socket.removeListener("connect", onConnect);
    socket.removeListener("error", failInitialConnect);
    try { socket.destroy(); } catch {}
    connectionLastError = error?.message || String(error);
    attemptPrimaryPromotion();
  }
  socket.once("connect", onConnect);
  socket.once("error", failInitialConnect);
}

function attemptPrimaryPromotion() {
  if (mode === "primary" || socketReady(primarySocket)) return;
  if (tcpServer.listening) {
    mode = "primary";
    primaryConnectInFlight = false;
    writePidfile();
    setConnectionRecoveryState(socketReady(nativeHostSocket) ? "connected" : "waiting_for_native_host");
    dispatchAllPendingRequests();
    return;
  }

  setConnectionRecoveryState("electing_primary");
  const onElectionError = (error) => {
    primaryConnectInFlight = false;
    if (error?.code === "EADDRINUSE") {
      mode = "client";
      scheduleClientRecovery("another_client_became_primary", 100);
      return;
    }
    scheduleClientRecovery(error?.message || "primary_election_failed");
  };
  tcpServer.once("error", onElectionError);
  try {
    tcpServer.listen(TCP_PORT, "127.0.0.1", () => {
      tcpServer.removeListener("error", onElectionError);
      clearClientRecoveryTimers();
      primaryConnectInFlight = false;
      mode = "primary";
      primaryConnectedAt = new Date().toISOString();
      writePidfile();
      process.stderr.write("Promoted client to primary MCP server on :" + TCP_PORT + "\n");
      setConnectionRecoveryState(socketReady(nativeHostSocket) ? "connected" : "waiting_for_native_host");
      dispatchAllPendingRequests();
    });
  } catch (error) {
    tcpServer.removeListener("error", onElectionError);
    primaryConnectInFlight = false;
    scheduleClientRecovery(error?.message || "primary_election_exception");
  }
}

function startClientMode() {
  mode = "client";
  process.stderr.write("Port " + TCP_PORT + " in use. Connecting as client to primary MCP server...\n");
  setConnectionRecoveryState("connecting_to_primary");
  connectToPrimaryOrPromote();
}

// --- Startup: try primary, fall back to client ---

async function start() {
  // Clean up stale pidfiles (but don't kill live servers)
  const pidfiles = [
    pidfilePath,
    path.join(os.tmpdir(), `unblocked-chrome-mcp-${TCP_PORT}.pid`),
  ];
  for (const pf of pidfiles) {
    try {
      const oldPid = parseInt(fs.readFileSync(pf, "utf-8").trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0); // Check if alive
          // It's alive. DON'T kill it. We'll run as client instead.
        } catch {
          // Dead process, clean up pidfile
          try { fs.unlinkSync(pf); } catch {}
        }
      }
    } catch {}
  }

  // Try to bind the port
  return new Promise((resolve) => {
    tcpServer.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        // Port taken by another live session. Run as client.
        startClientMode();
        resolve();
      } else {
        process.stderr.write(`TCP server error: ${err.message}\n`);
        process.exit(1);
      }
    });

    tcpServer.listen(TCP_PORT, "127.0.0.1", () => {
      mode = "primary";
      writePidfile();
      // CLAUDE_SIDEBAR_V67_PRIMARY_STARTED
      primaryConnectedAt = new Date().toISOString();
      setConnectionRecoveryState(socketReady(nativeHostSocket) ? "connected" : "waiting_for_native_host");
      process.stderr.write(`Primary MCP server listening on :${TCP_PORT}\n`);
      resolve();
    });
  });
}

await start();

// --- Helper to wrap tool results for MCP ---

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function imageResult(base64, mimeType = "image/png") {
  return { content: [{ type: "image", data: base64, mimeType }] };
}

function mixedResult(parts) {
  return { content: parts };
}

async function callTool(toolName, args) {
  // CLAUDE_SIDEBAR_V69_PAGE_BOUND_CALL
  const preparedPageContext = await prepareBrowserToolArgs(toolName, args || {});
  if (!preparedPageContext?.ok) return textResult(JSON.stringify(preparedPageContext, null, 2));
  args = preparedPageContext.args;

  // CLAUDE_SIDEBAR_V66_LEGACY_FULL_READ_GUARD
  if (toolName === "lark_read" && args?.backend !== "openapi" && ["document", "archive"].includes(String(args?.scope || "").toLowerCase())) {
    return textResult(JSON.stringify({
      ok: false,
      code: "legacy_full_document_read_disabled",
      reason: "legacy_browser_reader_cannot_verify_virtual_document_completeness",
      useTool: "lark_deep_read",
      suggestedArgs: { scope: "map", refresh: true, outlineAssist: true, maxBlocks: 5000, maxSteps: 2000 },
      doNotClaimComplete: true,
      readOnly: true
    }, null, 2));
  }

  try {
    const rawResult = await sendToExtension(toolName, args);
    const result = await transformBrowserImageResult(toolName, args, rawResult);
    if (typeof result === "string") return textResult(result);
    if (result && result.content) return result;
    return textResult(JSON.stringify(result, null, 2));
  } catch (err) {
    return textResult(`Error: ${err.message}`);
  }
}

// CLAUDE_SIDEBAR_V69_PAGE_CONTEXT_RUNTIME
const larkIndexManager = new LarkIndexManager();
const pageContextManager = new PageContextManager({ implicitIdleMs: 20000, recentPageTtlMs: 21600000, maxRecentPages: 50 });
let larkDocumentSession = null;
try { larkIndexManager.cleanupExpired(); } catch {}

const PAGE_BOUND_TOOLS = new Set([
  "navigate", "computer", "find", "form_input", "get_page_text", "gif_creator",
  "javascript_tool", "read_console_messages", "read_network_requests", "read_page",
  "resize_window", "upload_image", "get_screenshot", "lark_document_identity",
  "lark_deep_read", "lark_locate", "browser_app_inspect", "browser_app_query"
]);

function parseExtensionJsonResult(result) {
  const textPart = result?.content?.find?.((part) => part?.type === "text");
  if (!textPart?.text) return result;
  try { return JSON.parse(textPart.text); } catch { return { ok: false, code: "extension_result_not_json", raw: textPart.text }; }
}

async function rawExtensionJson(tool, args = {}) {
  const result = await sendToExtension(tool, args);
  return parseExtensionJsonResult(result);
}

async function captureBrowserPage(options = {}) {
  return rawExtensionJson("browser_page_context", {
    action: options.list ? "list" : "capture",
    tabId: options.tabId,
  });
}

async function resolveBrowserTarget(args = {}, options = {}) {
  const explicitTabId = Number(args?.tabId || 0);
  const semanticQuery = String(args?.pageHint || args?.query || (Array.isArray(args?.terms) ? args.terms.join(" ") : "") || "");
  const current = pageContextManager.current();
  if (current && !current.implicit && options.allowContextOverride !== true) {
    return pageContextManager.resolve(captureBrowserPage, {
      taskId: current.mode === "task" ? current.id : undefined,
      autoStart: false,
      query: semanticQuery,
      pageHint: args?.pageHint,
      allowSemanticRebind: true,
      preferRecent: options.preferRecent === true,
    });
  }
  if (explicitTabId) return pageContextManager.resolve(captureBrowserPage, { tabId: explicitTabId, autoStart: false });
  return pageContextManager.resolve(captureBrowserPage, {
    taskId: args?.taskId,
    autoStart: options.autoStart !== false,
    navigationPolicy: args?.allowNavigation === true ? "same_origin" : "same_page",
    query: semanticQuery,
    pageHint: args?.pageHint,
    allowRecentRecovery: true,
    allowSemanticRebind: true,
    preferRecent: options.preferRecent === true,
  });
}

async function prepareBrowserToolArgs(tool, args = {}) {
  if (!PAGE_BOUND_TOOLS.has(tool)) return { ok: true, args };
  let targetArgs = args;
  let preferRecent = false;
  if (tool === "browser_app_query") {
    preferRecent = true;
  } else if (tool === "browser_app_inspect") {
    targetArgs = { ...args, query: args.pageHint || "" };
    preferRecent = true;
  } else if (["lark_document_identity", "lark_deep_read", "lark_locate"].includes(tool)) {
    targetArgs = { ...args, query: args.pageHint || "lark feishu" };
    preferRecent = true;
  } else {
    targetArgs = { ...args, query: args.pageHint || "" };
  }
  const resolved = await resolveBrowserTarget(targetArgs, { preferRecent });
  if (!resolved?.ok) return resolved;
  return {
    ok: true,
    args: { ...args, tabId: resolved.identity.tabId },
    pageContext: resolved.context || null,
    targetSource: resolved.source,
  };
}

async function callExtensionJson(tool, args = {}) {
  if (tool === "browser_page_context") return rawExtensionJson(tool, args);
  const prepared = await prepareBrowserToolArgs(tool, args);
  if (!prepared?.ok) return prepared;
  const result = await rawExtensionJson(tool, prepared.args);
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...result, taskPage: prepared.pageContext || undefined, targetSource: prepared.targetSource || undefined };
  }
  return result;
}

async function currentLarkIdentity(tabId) {
  return callExtensionJson("lark_document_identity", { tabId });
}

async function locateCurrentLarkTarget(options = {}) {
  let targetHint = null;
  let indexMetadata = null;
  if (options.useIndex !== false) {
    let loaded = null;
    if (larkDocumentSession?.indexPath) loaded = larkIndexManager.readIndexPath(larkDocumentSession.indexPath, { touch: true });
    if (!loaded) {
      const identity = await currentLarkIdentity(options.tabId);
      if (identity?.ok) loaded = larkIndexManager.readIndexByUrl(identity.url, { touch: true });
    }
    if (loaded?.index) {
      const hinted = larkIndexManager.locateHint(loaded.index, options.query, { windowRadius: 100 });
      if (hinted?.found) targetHint = hinted.targetHint;
      indexMetadata = {
        exists: true,
        indexedAt: loaded.index.indexedAt,
        indexPath: loaded.indexPath,
        hintFound: hinted?.found === true,
        targetOrdinal: hinted?.targetHint?.ordinal ?? null,
      };
    } else {
      indexMetadata = { exists: false, indexedAt: null, hintFound: false, targetOrdinal: null };
    }
  }

  const result = await callExtensionJson("lark_locate", {
    ...options,
    targetHint,
  });
  return {
    ...result,
    index: indexMetadata,
  };
}

async function refreshCurrentLarkIndex(options = {}) {
  const cleanup = larkIndexManager.cleanupExpired();
  const map = await callExtensionJson("lark_deep_read", {
    scope: "map",
    tabId: options.tabId,
    refresh: true,
    maxBlocks: options.maxBlocks || 10000,
    maxSteps: options.maxSteps || 4000,
    maxTargets: options.maxTargets || 5,
    settleMs: options.settleMs || 80,
    requireOutlineCoverage: options.requireOutlineCoverage,
  });
  if (!map?.ok) return { ok: false, code: map?.code || "index_map_failed", detail: map, cleanup };
  if (map.scan?.complete !== true) {
    return {
      ok: false,
      code: "source_scan_incomplete",
      documentName: map.title,
      documentUrl: map.url,
      scan: map.scan,
      doNotReplaceExistingIndex: true,
      cleanup,
    };
  }

  const blockCount = Number(map.blockCount || 0);
  const blocks = [];
  const chunkSize = Math.max(100, Math.min(1000, Number(options.chunkSize || 800)));
  for (let startOrdinal = 0; startOrdinal < blockCount; startOrdinal += chunkSize) {
    const endOrdinal = Math.min(blockCount - 1, startOrdinal + chunkSize - 1);
    const range = await callExtensionJson("lark_deep_read", {
      scope: "range",
      tabId: options.tabId,
      startOrdinal,
      endOrdinal,
      maxReturnBlocks: chunkSize,
      maxBlocks: options.maxBlocks || 10000,
      refresh: false,
    });
    if (!range?.ok || !Array.isArray(range.blocks)) {
      return {
        ok: false,
        code: "index_range_failed",
        failedRange: { startOrdinal, endOrdinal },
        detail: range,
        doNotReplaceExistingIndex: true,
        cleanup,
      };
    }
    blocks.push(...range.blocks);
  }

  if (blocks.length !== blockCount) {
    return {
      ok: false,
      code: "index_block_count_mismatch",
      expectedBlockCount: blockCount,
      actualBlockCount: blocks.length,
      doNotReplaceExistingIndex: true,
      cleanup,
    };
  }

  const saved = larkIndexManager.writeIndex({
    documentName: map.title,
    documentUrl: map.url,
    documentType: map.scan?.documentType || map.documentType || "rich_doc",
    blockCount,
    scan: map.scan,
    sections: map.sections || [],
    blocks,
  });
  larkDocumentSession = {
    mode: options.sessionMode || "new",
    indexPath: saved.indexPath,
    documentName: saved.index.documentName,
    documentUrl: saved.index.documentUrl,
    indexedAt: saved.index.indexedAt,
  };
  return {
    ok: true,
    action: "index_refreshed",
    sessionMode: larkDocumentSession.mode,
    indexPath: saved.indexPath,
    documentName: saved.index.documentName,
    documentUrl: saved.index.documentUrl,
    indexedAt: saved.index.indexedAt,
    lastOpenedAt: saved.index.lastOpenedAt,
    blockCount: saved.index.blockCount,
    indexedBlockCount: saved.index.indexedBlockCount,
    sectionCount: saved.index.sectionCount,
    cleanup,
  };
}

async function startLarkDocumentSession(options = {}) {
  const mode = options.mode === "history" ? "history" : "new";
  if (mode === "new") return refreshCurrentLarkIndex({ ...options, sessionMode: "new" });

  const cleanup = larkIndexManager.cleanupExpired();
  const identity = await currentLarkIdentity(options.tabId);
  if (!identity?.ok) return { ok: false, code: identity?.code || "document_identity_failed", detail: identity, cleanup };
  const loaded = larkIndexManager.readIndexByUrl(identity.url, { touch: true });
  if (!loaded) {
    larkDocumentSession = null;
    return {
      ok: true,
      action: "history_index_missing",
      sessionMode: "history",
      documentName: identity.title,
      documentUrl: identity.url,
      indexExists: false,
      userAction: "Ask Claude to refresh the current document index.",
      cleanup,
    };
  }
  larkDocumentSession = {
    mode: "history",
    indexPath: loaded.indexPath,
    documentName: loaded.index.documentName,
    documentUrl: loaded.index.documentUrl,
    indexedAt: loaded.index.indexedAt,
  };
  return {
    ok: true,
    action: "history_index_loaded",
    sessionMode: "history",
    indexExists: true,
    indexPath: loaded.indexPath,
    documentName: loaded.index.documentName,
    documentUrl: loaded.index.documentUrl,
    indexedAt: loaded.index.indexedAt,
    lastOpenedAt: loaded.index.lastOpenedAt,
    blockCount: loaded.index.blockCount,
    sectionCount: loaded.index.sectionCount,
    cleanup,
  };
}

async function ensureLarkQuerySession(options = {}) {
  if (options.refresh === true) return refreshCurrentLarkIndex({ ...options, sessionMode: larkDocumentSession?.mode || options.sessionMode || "new" });
  if (larkDocumentSession?.indexPath) {
    const loaded = larkIndexManager.readIndexPath(larkDocumentSession.indexPath, { touch: true });
    if (loaded) return { ok: true, loaded };
    larkDocumentSession = null;
  }

  if (options.sessionMode === "new") {
    const refreshed = await refreshCurrentLarkIndex({ ...options, sessionMode: "new" });
    if (!refreshed.ok) return refreshed;
    return { ok: true, loaded: larkIndexManager.readIndexPath(refreshed.indexPath, { touch: true }) };
  }

  const identity = await currentLarkIdentity(options.tabId);
  if (!identity?.ok) return { ok: false, code: identity?.code || "document_identity_failed", detail: identity };
  const loaded = larkIndexManager.readIndexByUrl(identity.url, { touch: true });
  if (!loaded) {
    return {
      ok: false,
      code: "index_missing",
      documentName: identity.title,
      documentUrl: identity.url,
      indexedAt: null,
      userAction: "Refresh the current document index before asking detailed questions.",
    };
  }
  larkDocumentSession = {
    mode: options.sessionMode || "history",
    indexPath: loaded.indexPath,
    documentName: loaded.index.documentName,
    documentUrl: loaded.index.documentUrl,
    indexedAt: loaded.index.indexedAt,
  };
  return { ok: true, loaded };
}

// --- MCP Server with all 18 tools ---

const server = new McpServer({
  name: "open-claude-in-chrome",
  version: "1.0.0",
});

// Pre-validation arg coercion
{
  const origSetRequestHandler = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = function(schema, handler) {
    return origSetRequestHandler(schema, async (request, extra) => {
      const args = request?.params?.arguments;
      if (args) {
        if (typeof args.tabId === "string") args.tabId = Number(args.tabId);
        if (typeof args.coordinate === "string") {
          try { args.coordinate = JSON.parse(args.coordinate); } catch {}
        }
        if (typeof args.start_coordinate === "string") {
          try { args.start_coordinate = JSON.parse(args.start_coordinate); } catch {}
        }
        if (typeof args.region === "string") {
          try { args.region = JSON.parse(args.region); } catch {}
        }
      }
      return handler(request, extra);
    });
  };
}
// 1. tabs_context_mcp
server.tool(
  "tabs_context_mcp",
  "Get context information about the current MCP tab group. Returns all tab IDs inside the group if it exists. CRITICAL: You must get the context at least once before using other browser automation tools so you know what tabs exist. A browser side-panel session may expose an explicitly adopted current tab. Reuse that tab when the user asks about the current page. Otherwise create a new tab for unrelated browsing tasks.",
  { createIfEmpty: z.boolean().optional().describe("Creates a new MCP tab group if none exists, creates a new Window with a new tab group containing an empty tab (which can be used for this conversation). If a MCP tab group already exists, this parameter has no effect.") },
  async (args) => callTool("tabs_context_mcp", args)
);

// 2. tabs_create_mcp
server.tool(
  "tabs_create_mcp",
  "Creates a new empty tab in the MCP tab group. Do not use this when the user explicitly refers to an adopted current browser tab. Get context with tabs_context_mcp first.",
  {},
  async (args) => callTool("tabs_create_mcp", args)
);

// 3. navigate
server.tool(
  "navigate",
  'Navigate to a URL, or go forward/back in browser history. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
  {
    url: z.string().describe('The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use "forward" to go forward in history or "back" to go back in history.'),
    tabId: z.number().describe("Tab ID to navigate. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("navigate", args)
);

// 4. computer
server.tool(
  "computer",
  "Use a mouse and keyboard to interact with a web browser, and take screenshots. On macOS Claude Sidebar may run in safe-text image mode: screenshot/zoom/scroll still execute in Chrome but return an accessibility snapshot instead of MCP image content. Do not repeatedly retry screenshots when the safe-mode notice is returned. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.\n* Whenever you intend to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.\n* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.\n* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.",
  {
    action: z.enum([
      "left_click", "right_click", "double_click", "triple_click",
      "type", "screenshot", "wait", "scroll", "key",
      "left_click_drag", "zoom", "scroll_to", "hover"
    ]).describe('The action to perform:\n* `left_click`: Click the left mouse button at the specified coordinates.\n* `right_click`: Click the right mouse button at the specified coordinates to open context menus.\n* `double_click`: Double-click the left mouse button at the specified coordinates.\n* `triple_click`: Triple-click the left mouse button at the specified coordinates.\n* `type`: Type a string of text.\n* `screenshot`: Take a screenshot of the screen.\n* `wait`: Wait for a specified number of seconds.\n* `scroll`: Scroll up, down, left, or right at the specified coordinates.\n* `key`: Press a specific keyboard key.\n* `left_click_drag`: Drag from start_coordinate to coordinate.\n* `zoom`: Take a screenshot of a specific region for closer inspection.\n* `scroll_to`: Scroll an element into view using its element reference ID from read_page or find tools.\n* `hover`: Move the mouse cursor to the specified coordinates or element without clicking. Useful for revealing tooltips, dropdown menus, or triggering hover states.'),
    tabId: z.number().describe("Tab ID to execute the action on. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    coordinate: z.array(z.number()).min(2).max(2).optional().describe("(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates. Required for `left_click`, `right_click`, `double_click`, `triple_click`, and `scroll`. For `left_click_drag`, this is the end position."),
    duration: z.number().min(0).max(30).optional().describe("The number of seconds to wait. Required for `wait`. Maximum 30 seconds."),
    modifiers: z.string().optional().describe('Modifier keys for click actions. Supports: "ctrl", "shift", "alt", "cmd" (or "meta"), "win" (or "windows"). Can be combined with "+" (e.g., "ctrl+shift", "cmd+alt"). Optional.'),
    ref: z.string().optional().describe('Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Required for `scroll_to` action. Can be used as alternative to `coordinate` for click actions.'),
    region: z.array(z.number()).min(4).max(4).optional().describe("(x0, y0, x1, y1): The rectangular region to capture for `zoom`. Coordinates define a rectangle from top-left (x0, y0) to bottom-right (x1, y1) in pixels from the viewport origin. Required for `zoom` action. Useful for inspecting small UI elements like icons, buttons, or text."),
    repeat: z.number().min(1).max(100).optional().describe("Number of times to repeat the key sequence. Only applicable for `key` action. Must be a positive integer between 1 and 100. Default is 1. Useful for navigation tasks like pressing arrow keys multiple times."),
    scroll_direction: z.enum(["up", "down", "left", "right"]).optional().describe("The direction to scroll. Required for `scroll`."),
    scroll_amount: z.number().min(1).max(10).optional().describe("The number of scroll wheel ticks. Optional for `scroll`, defaults to 3."),
    start_coordinate: z.array(z.number()).min(2).max(2).optional().describe("(x, y): The starting coordinates for `left_click_drag`."),
    text: z.string().optional().describe('The text to type (for `type` action) or the key(s) to press (for `key` action). For `key` action: Provide space-separated keys (e.g., "Backspace Backspace Delete"). Supports keyboard shortcuts using the platform\'s modifier key (use "cmd" on Mac, "ctrl" on Windows/Linux, e.g., "cmd+a" or "ctrl+a" for select all).'),
  },
  async (args) => callTool("computer", args)
);

// 5. find
server.tool(
  "find",
  'Find elements on the page using natural language. Can search for elements by their purpose (e.g., "search bar", "login button") or by text content (e.g., "organic mango product"). Returns up to 20 matching elements with references that can be used with other tools. If more than 20 matches exist, you\'ll be notified to use a more specific query. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
  {
    query: z.string().describe('Natural language description of what to find (e.g., "search bar", "add to cart button", "product title containing organic")'),
    tabId: z.number().describe("Tab ID to search in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("find", args)
);

// 6. form_input
server.tool(
  "form_input",
  "Set values in form elements using element reference ID from the read_page tool. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    ref: z.string().describe('Element reference ID from the read_page tool (e.g., "ref_1", "ref_2")'),
    value: z.union([z.string(), z.boolean(), z.number()]).describe("The value to set. For checkboxes use boolean, for selects use option value or text, for other inputs use appropriate string/number"),
    tabId: z.number().describe("Tab ID to set form value in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("form_input", args)
);

// 7. get_page_text
server.tool(
  "get_page_text",
  "Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or other text-heavy pages. Returns plain text without HTML formatting. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    tabId: z.number().describe("Tab ID to extract text from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("get_page_text", args)
);

// 8. gif_creator
server.tool(
  "gif_creator",
  "Manage GIF recording and export for browser automation sessions. Control when to start/stop recording browser actions (clicks, scrolls, navigation), then export as an animated GIF with visual overlays (click indicators, action labels, progress bar, watermark). All operations are scoped to the tab's group. When starting recording, take a screenshot immediately after to capture the initial state as the first frame. When stopping recording, take a screenshot immediately before to capture the final state as the last frame. For export, either provide 'coordinate' to drag/drop upload to a page element, or set 'download: true' to download the GIF.",
  {
    action: z.enum(["start_recording", "stop_recording", "export", "clear"]).describe("Action to perform: 'start_recording' (begin capturing), 'stop_recording' (stop capturing but keep frames), 'export' (generate and export GIF), 'clear' (discard frames)"),
    tabId: z.number().describe("Tab ID to identify which tab group this operation applies to"),
    download: z.boolean().optional().describe("Always set this to true for the 'export' action only. This causes the gif to be downloaded in the browser."),
    filename: z.string().optional().describe("Optional filename for exported GIF (default: 'recording-[timestamp].gif'). For 'export' action only."),
    options: z.object({
      showClickIndicators: z.boolean().optional().describe("Show orange circles at click locations (default: true)"),
      showDragPaths: z.boolean().optional().describe("Show red arrows for drag actions (default: true)"),
      showActionLabels: z.boolean().optional().describe("Show black labels describing actions (default: true)"),
      showProgressBar: z.boolean().optional().describe("Show orange progress bar at bottom (default: true)"),
      showWatermark: z.boolean().optional().describe("Show Claude logo watermark (default: true)"),
      quality: z.number().optional().describe("GIF compression quality, 1-30 (lower = better quality, slower encoding). Default: 10"),
    }).optional().describe("Optional GIF enhancement options for 'export' action. Properties: showClickIndicators (bool), showDragPaths (bool), showActionLabels (bool), showProgressBar (bool), showWatermark (bool), quality (number 1-30). All default to true except quality (default: 10)."),
  },
  async (args) => callTool("gif_creator", args)
);

// 9. javascript_tool
server.tool(
  "javascript_tool",
  "Execute JavaScript code in the context of the current page. The code runs in the page's context and can interact with the DOM, window object, and page variables. Returns the result of the last expression or any thrown errors. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    action: z.literal("javascript_exec").describe("Must be set to 'javascript_exec'"),
    text: z.string().describe("The JavaScript code to execute. The code will be evaluated in the page context. The result of the last expression will be returned automatically. Do NOT use 'return' statements - just write the expression you want to evaluate (e.g., 'window.myData.value' not 'return window.myData.value'). You can access and modify the DOM, call page functions, and interact with page variables."),
    tabId: z.number().describe("Tab ID to execute the code in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("javascript_tool", args)
);

// 10. read_console_messages
server.tool(
  "read_console_messages",
  "Read browser console messages (console.log, console.error, console.warn, etc.) from a specific tab. Useful for debugging JavaScript errors, viewing application logs, or understanding what's happening in the browser console. Returns console messages from the current domain only. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs. IMPORTANT: Always provide a pattern to filter messages - without a pattern, you may get too many irrelevant messages.",
  {
    tabId: z.number().describe("Tab ID to read console messages from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    pattern: z.string().optional().describe("Regex pattern to filter console messages. Only messages matching this pattern will be returned (e.g., 'error|warning' to find errors and warnings, 'MyApp' to filter app-specific logs). You should always provide a pattern to avoid getting too many irrelevant messages."),
    limit: z.number().optional().describe("Maximum number of messages to return. Defaults to 100. Increase only if you need more results."),
    onlyErrors: z.boolean().optional().describe("If true, only return error and exception messages. Default is false (return all message types)."),
    clear: z.boolean().optional().describe("If true, clear the console messages after reading to avoid duplicates on subsequent calls. Default is false."),
  },
  async (args) => callTool("read_console_messages", args)
);

// 11. read_network_requests
server.tool(
  "read_network_requests",
  "Read HTTP network requests (XHR, Fetch, documents, images, etc.) from a specific tab. Useful for debugging API calls, monitoring network activity, or understanding what requests a page is making. Returns all network requests made by the current page, including cross-origin requests. Requests are automatically cleared when the page navigates to a different domain. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    tabId: z.number().describe("Tab ID to read network requests from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    urlPattern: z.string().optional().describe("Optional URL pattern to filter requests. Only requests whose URL contains this string will be returned (e.g., '/api/' to filter API calls, 'example.com' to filter by domain)."),
    limit: z.number().optional().describe("Maximum number of requests to return. Defaults to 100. Increase only if you need more results."),
    clear: z.boolean().optional().describe("If true, clear the network requests after reading to avoid duplicates on subsequent calls. Default is false."),
  },
  async (args) => callTool("read_network_requests", args)
);

// 12. read_page
server.tool(
  "read_page",
  "Get an accessibility tree representation of elements on the page. By default returns all elements including non-visible ones. Output is limited to 50000 characters by default. If the output exceeds this limit, you will receive an error asking you to specify a smaller depth or focus on a specific element using ref_id. Optionally filter for only interactive elements. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    tabId: z.number().describe("Tab ID to read from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    filter: z.enum(["interactive", "all"]).optional().describe('Filter elements: "interactive" for buttons/links/inputs only, "all" for all elements including non-visible ones (default: all elements)'),
    depth: z.number().optional().describe("Maximum depth of the tree to traverse (default: 15). Use a smaller depth if output is too large."),
    ref_id: z.string().optional().describe("Reference ID of a parent element to read. Will return the specified element and all its children. Use this to focus on a specific part of the page when output is too large."),
    max_chars: z.number().optional().describe("Maximum characters for output (default: 50000). Set to a higher value if your client can handle large outputs."),
  },
  async (args) => callTool("read_page", args)
);

// 13. resize_window
server.tool(
  "resize_window",
  "Resize the current browser window to specified dimensions. Useful for testing responsive designs or setting up specific screen sizes. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    width: z.number().describe("Target window width in pixels"),
    height: z.number().describe("Target window height in pixels"),
    tabId: z.number().describe("Tab ID to get the window for. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("resize_window", args)
);

// 14. shortcuts_list
server.tool(
  "shortcuts_list",
  "List all available shortcuts and workflows (shortcuts and workflows are interchangeable). Returns shortcuts with their commands, descriptions, and whether they are workflows. Use shortcuts_execute to run a shortcut or workflow.",
  {
    tabId: z.number().describe("Tab ID to list shortcuts from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("shortcuts_list", args)
);

// 15. shortcuts_execute
server.tool(
  "shortcuts_execute",
  "Execute a shortcut or workflow by running it in a new sidepanel window using the current tab (shortcuts and workflows are interchangeable). Use shortcuts_list first to see available shortcuts. This starts the execution and returns immediately - it does not wait for completion.",
  {
    tabId: z.number().describe("Tab ID to execute the shortcut on. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    shortcutId: z.string().optional().describe("The ID of the shortcut to execute"),
    command: z.string().optional().describe("The command name of the shortcut to execute (e.g., 'debug', 'summarize'). Do not include the leading slash."),
  },
  async (args) => callTool("shortcuts_execute", args)
);

// 16. switch_browser
server.tool(
  "switch_browser",
  "Switch which Chrome browser is used for browser automation. Call this when the user wants to connect to a different Chrome browser. Broadcasts a connection request to all Chrome browsers with the extension installed \u2014 the user clicks 'Connect' in the desired browser.",
  {},
  async (args) => callTool("switch_browser", args)
);

// 17. update_plan
server.tool(
  "update_plan",
  "Present a plan to the user for approval before taking actions. The user will see the domains you intend to visit and your approach. Once approved, you can proceed with actions on the approved domains without additional permission prompts.",
  {
    domains: z.array(z.string()).describe("List of domains you will visit (e.g., ['github.com', 'stackoverflow.com']). These domains will be approved for the session when the user accepts the plan."),
    approach: z.array(z.string()).describe("High-level description of what you will do. Focus on outcomes and key actions, not implementation details. Be concise - aim for 3-7 items."),
  },
  async (args) => callTool("update_plan", args)
);

// 18. upload_image
server.tool(
  "upload_image",
  "Upload a previously captured screenshot or user-uploaded image to a file input or drag & drop target. Supports two approaches: (1) ref - for targeting specific elements, especially hidden file inputs, (2) coordinate - for drag & drop to visible locations like Google Docs. Provide either ref or coordinate, not both.",
  {
    imageId: z.string().describe("ID of a previously captured screenshot (from the computer tool's screenshot action) or a user-uploaded image"),
    tabId: z.number().describe("Tab ID where the target element is located. This is where the image will be uploaded to."),
    ref: z.string().optional().describe('Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Use this for file inputs (especially hidden ones) or specific elements. Provide either ref or coordinate, not both.'),
    coordinate: z.array(z.number()).optional().describe("Viewport coordinates [x, y] for drag & drop to a visible location. Use this for drag & drop targets like Google Docs. Provide either ref or coordinate, not both."),
    filename: z.string().optional().describe('Optional filename for the uploaded file (default: "image.png")'),
  },
  async (args) => callTool("upload_image", args)
);


// --- Dynamic capability adapters ---
capabilityRegistry = new CapabilityRegistry(server);
const larkAdapter = registerLarkAdapter({
  server,
  z,
  getContext: () => getEffectiveBrowserContext(),
  sendToExtension,
});
capabilityRegistry.registerAdapter(larkAdapter);
capabilityRegistry.updateContext(currentBrowserContext);

// --- Start MCP server ---


// CLAUDE_SIDEBAR_V69_ALPHA9_PAGE_CONTEXT_TOOL
server.tool(
  "sidebar_connection_status",
  "Return local MCP primary/client and browser native-host connection diagnostics. This tool does not call the browser and remains available while the browser transport is recovering.",
  {},
  async () => textResult(JSON.stringify(getSidebarConnectionStatus(), null, 2))
);

server.tool(
  "browser_page_context",
  "Manage and recover the page bound to the current browser task across the entire browser, not only the MCP tab group. At task start, pass pageHint when the user names an app/site/resource such as K8s, Jenkins or a document. Existing matching tabs are reused without activation; switching the visible tab does not close or replace the task page. list_pages returns every open browser tab. Never open a duplicate page before checking this tool.",
  {
    action: z.enum(["start_task", "end_task", "pin_current", "follow_current", "status", "list_pages"]),
    tabId: z.number().optional(),
    taskId: z.string().optional(),
    alias: z.string().optional(),
    pageHint: z.string().optional().describe("Natural-language app, site, title, host or resource hint used to recover an already-open tab across all browser windows."),
    allowNavigation: z.boolean().optional().describe("Allow same-origin route changes in the bound tab. Defaults to false so accidental page navigation is detected."),
  },
  async (args) => {
    const policy = args.allowNavigation === true ? "same_origin" : "same_page";
    let result;
    if (args.action === "start_task") {
      if (pageContextManager.activeTaskId) pageContextManager.end(pageContextManager.activeTaskId, "replaced_by_new_task");
      result = await pageContextManager.start(captureBrowserPage, {
        mode: "task",
        tabId: args.tabId,
        alias: args.alias,
        pageHint: args.pageHint,
        query: args.pageHint,
        navigationPolicy: policy,
      });
    } else if (args.action === "end_task") {
      result = { ok: true, action: "task_ended", context: pageContextManager.end(args.taskId || pageContextManager.activeTaskId, "completed") };
    } else if (args.action === "pin_current") {
      pageContextManager.unpin();
      result = await pageContextManager.start(captureBrowserPage, {
        mode: "pinned",
        tabId: args.tabId,
        alias: args.alias,
        pageHint: args.pageHint,
        query: args.pageHint,
        navigationPolicy: policy,
      });
    } else if (args.action === "follow_current") {
      const task = pageContextManager.activeTaskId ? pageContextManager.end(pageContextManager.activeTaskId, "follow_current") : null;
      const pin = pageContextManager.unpin();
      result = { ok: true, action: "follow_current_enabled", releasedTask: task, releasedPin: pin };
    } else if (args.action === "list_pages") {
      result = await captureBrowserPage({ list: true });
    } else {
      result = pageContextManager.status();
    }
    return textResult(JSON.stringify(result, null, 2));
  }
);

server.tool(
  "lark_session_start",
  "Lifecycle tool for the Sidebar. Call with mode=new when a new conversation is created: code refreshes the current Lark index before the conversation uses it. Call with mode=history when reopening a historical conversation: code loads the existing local index without refreshing and returns the last indexed time.",
  {
    mode: z.enum(["new", "history"]),
    tabId: z.number().optional(),
    maxBlocks: z.number().int().min(1).max(20000).optional(),
    maxSteps: z.number().int().min(1).max(4000).optional(),
    chunkSize: z.number().int().min(100).max(1000).optional(),
  },
  async (args) => textResult(JSON.stringify(await startLarkDocumentSession(args), null, 2))
);

server.tool(
  "lark_index_refresh",
  "Refresh the local index for the current Lark document. Claude should call this only after the user explicitly asks to update, refresh, reread, or answer from the latest document. The code performs scanning, indexing and atomic file replacement.",
  {
    tabId: z.number().optional(),
    maxBlocks: z.number().int().min(1).max(20000).optional(),
    maxSteps: z.number().int().min(1).max(4000).optional(),
    chunkSize: z.number().int().min(100).max(1000).optional(),
  },
  async (args) => textResult(JSON.stringify(await refreshCurrentLarkIndex({ ...args, sessionMode: larkDocumentSession?.mode || "history" }), null, 2))
);

server.tool(
  "lark_index_status",
  "Return whether the current Lark document has a local index and its last indexed time. This does not refresh document content.",
  { tabId: z.number().optional() },
  async (args) => {
    const identity = await currentLarkIdentity(args.tabId);
    if (!identity?.ok) return textResult(JSON.stringify(identity, null, 2));
    const loaded = larkIndexManager.readIndexByUrl(identity.url, { touch: true });
    return textResult(JSON.stringify(loaded ? {
      ok: true,
      exists: true,
      documentName: loaded.index.documentName,
      documentUrl: loaded.index.documentUrl,
      indexPath: loaded.indexPath,
      indexedAt: loaded.index.indexedAt,
      lastOpenedAt: loaded.index.lastOpenedAt,
      blockCount: loaded.index.blockCount,
      sectionCount: loaded.index.sectionCount,
    } : {
      ok: true,
      exists: false,
      documentName: identity.title,
      documentUrl: identity.url,
      indexedAt: null,
    }, null, 2));
  }
);

server.tool(
  "lark_query",
  "Query the local index of the current Lark document in one call. It returns compact relevant source context and the index timestamp so Claude can answer directly. It does not refresh a historical session unless refresh=true or the user explicitly asked for an update.",
  {
    question: z.string().min(1),
    tabId: z.number().optional(),
    sessionMode: z.enum(["new", "history"]).optional(),
    refresh: z.boolean().optional(),
    limit: z.number().int().min(1).max(20).optional(),
    contextBefore: z.number().int().min(0).max(5).optional(),
    contextAfter: z.number().int().min(0).max(5).optional(),
    maxContextChars: z.number().int().min(500).max(30000).optional(),
  },
  async (args) => {
    const session = await ensureLarkQuerySession(args);
    if (!session?.ok) return textResult(JSON.stringify(session, null, 2));
    const queried = larkIndexManager.query(session.loaded.index, args.question, args);
    return textResult(JSON.stringify({
      ...queried,
      indexPath: session.loaded.indexPath,
      sessionMode: larkDocumentSession?.mode || args.sessionMode || "history",
      indexNotice: "This answer context is based on the local index updated at " + session.loaded.index.indexedAt + ".",
    }, null, 2));
  }
);

server.tool(
  "lark_index_cleanup",
  "Delete local Lark indexes that have not been opened for more than the retention period. Default retention is 30 days. Normally invoked automatically by code.",
  { retentionDays: z.number().int().min(1).max(365).optional() },
  async (args) => textResult(JSON.stringify(larkIndexManager.cleanupExpired(args), null, 2))
);

server.tool(
  "lark_deep_read",
  "Read a large current Lark/Feishu document without modifying it. Use scope=map first. The outline is optional and only acts as completeness evidence for rich documents; it is never clicked. Search defaults to leaf blocks, removes aggregate-container hits, merges adjacent duplicates, and supports cursor pagination.",
  {
    scope: z.enum(["map", "section", "range", "search"]).default("map"),
    tabId: z.number().optional(),
    sectionId: z.string().optional(),
    sectionTitle: z.string().optional(),
    startOrdinal: z.number().int().nonnegative().optional(),
    endOrdinal: z.number().int().nonnegative().optional(),
    query: z.string().optional(),
    caseSensitive: z.boolean().optional(),
    contextBefore: z.number().int().min(0).max(20).optional(),
    contextAfter: z.number().int().min(0).max(20).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.number().int().nonnegative().optional(),
    leafOnly: z.boolean().optional(),
    includeContainers: z.boolean().optional(),
    withinSection: z.string().optional(),
    blockTypes: z.array(z.string()).optional(),
    maxTextCharsPerMatch: z.number().int().min(80).max(10000).optional(),
    maxTotalChars: z.number().int().min(1000).max(200000).optional(),
    maxReturnBlocks: z.number().int().min(1).max(1000).optional(),
    maxBlocks: z.number().int().min(1).max(20000).optional(),
    maxSteps: z.number().int().min(1).max(4000).optional(),
    maxTargets: z.number().int().min(1).max(5).optional(),
    bottomStableSteps: z.number().int().min(3).max(20).optional(),
    outlineAssist: z.boolean().optional().describe("Deprecated compatibility flag. The reader never clicks the outline."),
    requireOutlineCoverage: z.boolean().optional().describe("Require complete outline coverage when the detected type is rich_doc."),
    maxOutlineEntries: z.number().int().min(1).max(500).optional(),
    settleMs: z.number().int().min(20).max(1200).optional(),
    refresh: z.boolean().optional().describe("Force a fresh browser scan instead of using the short-lived complete document-map cache."),
  },
  async (args) => callTool("lark_deep_read", args)
);

server.tool(
  "lark_locate",
  "Locate text in the current Lark/Feishu content with the reusable indexed virtual-scroll seek engine. The host enriches the request with local index position anchors when available, then the browser performs coarse positioning, adaptive correction and DOM visibility verification. The tool never clicks, presses keys, or uses screenshot recognition.",
  {
    query: z.string().min(1),
    tabId: z.number().optional(),
    strategy: z.enum(["auto", "dom", "table", "virtual_scroll", "scroll_only"]).default("auto"),
    documentType: z.enum(["auto", "rich_doc", "sheet", "table", "canvas", "generic_page"]).default("auto"),
    matchMode: z.enum(["contains", "exact", "regex"]).default("contains"),
    caseSensitive: z.boolean().optional(),
    contextBefore: z.number().int().min(0).max(10).optional(),
    contextAfter: z.number().int().min(0).max(10).optional(),
    maxContextChars: z.number().int().min(200).max(20000).optional(),
    maxSteps: z.number().int().min(1).max(5000).optional(),
    maxTargets: z.number().int().min(1).max(5).optional(),
    settleMs: z.number().int().min(20).max(1200).optional(),
    stableChecks: z.number().int().min(2).max(5).optional(),
    useIndex: z.boolean().optional().describe("Use the current local document index to provide target ordinal and position anchors. Defaults to true."),
    searchFromTop: z.boolean().optional(),
    restoreOnNotFound: z.boolean().optional(),
    block: z.enum(["start", "center", "end", "nearest"]).optional(),
  },
  async (args) => textResult(JSON.stringify(await locateCurrentLarkTarget(args), null, 2))
);


server.tool(
  "browser_app_inspect",
  "Inspect any modern Web application as structured read-only state. It can recover an already-open matching tab across all browser windows and must not reopen a page merely because it is outside the MCP tab group. Returns route, query parameters, active controls and filters, breadcrumbs, navigation, pagination, tables, grids, lists, detail fields and artifact references without screenshots, clicks, keyboard input or URL mutation. Use this for management consoles, dashboards and internal admin systems before attempting visual interaction.",
  {
    tabId: z.number().optional(),
    pageHint: z.string().optional().describe("Optional app/site/title/host hint for reusing an already-open tab instead of the current active tab."),
    maxControls: z.number().int().min(1).max(250).optional(),
    maxSurfaces: z.number().int().min(1).max(12).optional(),
    maxNavigationLinks: z.number().int().min(1).max(250).optional(),
    maxDetailPairs: z.number().int().min(1).max(400).optional(),
    maxTextChars: z.number().int().min(1000).max(60000).optional(),
  },
  async (args) => callTool("browser_app_inspect", args)
);

server.tool(
  "browser_app_query",
  "Query any modern Web application in one read-only call. It searches all open browser tabs for a semantic page match and reuses an existing page before considering the active tab; never open a duplicate just because the user switched tabs. Searches tables, ARIA grids, virtual lists, cards, detail fields, embedded application state and observed same-origin JSON GET endpoints. Use it when the visible list does not expose the real entity name and the answer may be nested in command, args, image, metadata or configuration data. The result includes resolvedEntities with concrete resource names and evidence paths; do not stop at a vague statement when resolvedEntities is non-empty. It never operates the page search UI and never sends write requests.",
  {
    query: z.string().min(1),
    terms: z.array(z.string().min(1)).max(20).optional(),
    fields: z.array(z.string().min(1)).max(30).optional(),
    tabId: z.number().optional(),
    pageHint: z.string().optional().describe("Optional app/site/title/host hint. The natural-language query is also used to recover a matching already-open tab."),
    matchMode: z.enum(["contains", "exact", "regex"]).default("contains"),
    caseSensitive: z.boolean().optional(),
    maxSteps: z.number().int().min(1).max(2500).optional(),
    maxRows: z.number().int().min(1).max(1000).optional(),
    maxSurfaces: z.number().int().min(1).max(12).optional(),
    settleMs: z.number().int().min(20).max(1200).optional(),
    stopAfterMatches: z.number().int().min(1).max(1000).optional(),
    scanToBottom: z.boolean().optional(),
    searchFromTop: z.boolean().optional(),
    restoreScroll: z.boolean().optional(),
    followDetails: z.enum(["auto", "never", "always"]).default("auto"),
    maxDetailLinks: z.number().int().min(1).max(3).optional(),
    detailTimeoutMs: z.number().int().min(3000).max(30000).optional(),
    detailSettleMs: z.number().int().min(200).max(3000).optional(),
    dataMode: z.enum(["auto", "never", "always"]).default("auto").describe("Read embedded state and, when needed, observed same-origin JSON GET data sources. auto fetches network data when DOM results are absent or requested fields are missing."),
    deepSearch: z.boolean().optional().describe("Force nested structured-data search even when a visible DOM row already matched."),
    maxDataSources: z.number().int().min(1).max(12).optional(),
    maxDataMatches: z.number().int().min(1).max(200).optional(),
    maxResolvedEntities: z.number().int().min(1).max(100).optional(),
    maxDataNodes: z.number().int().min(100).max(250000).optional(),
    maxDataDepth: z.number().int().min(1).max(40).optional(),
    maxContextFields: z.number().int().min(1).max(300).optional(),
    maxDataBytes: z.number().int().min(10000).max(10000000).optional(),
    dataTimeoutMs: z.number().int().min(500).max(20000).optional(),
  },
  async (args) => callTool("browser_app_query", args)
);


const transport = new StdioServerTransport();
await server.connect(transport);
