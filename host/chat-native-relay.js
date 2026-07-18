#!/usr/bin/env node

import net from "node:net";
import os from "node:os";
import path from "node:path";

const DAEMON_SOCKET_PATH = process.env.CLAUDE_SIDEBAR_DAEMON_SOCKET || path.join(
  os.tmpdir(),
  `claude-sidebar-daemon-${typeof process.getuid === "function" ? process.getuid() : "user"}.sock`,
);
const CONNECT_TIMEOUT_MS = 4000;

let nativeInputBuffer = Buffer.alloc(0);
let daemonSocket = null;
let daemonLineBuffer = "";
let connected = false;
let ending = false;
let reconnectTimer = null;
let lastDaemonErrorAt = 0;
const outboundQueue = [];

function errorText(error) {
  return error?.stack || error?.message || String(error);
}

function writeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

function queueOrSend(message) {
  const line = `${JSON.stringify(message)}\n`;
  if (connected && daemonSocket && !daemonSocket.destroyed) {
    daemonSocket.write(line);
  } else {
    outboundQueue.push(line);
  }
}

function flushQueue() {
  if (!connected || !daemonSocket || daemonSocket.destroyed) return;
  while (outboundQueue.length > 0) {
    daemonSocket.write(outboundQueue.shift());
  }
}

function parseNativeMessages() {
  while (nativeInputBuffer.length >= 4) {
    const length = nativeInputBuffer.readUInt32LE(0);
    if (length > 64 * 1024 * 1024) {
      writeNativeMessage({
        type: "boot_error",
        stage: "native_protocol",
        error: `Native message too large: ${length} bytes`,
      });
      process.exit(1);
    }
    if (nativeInputBuffer.length < 4 + length) return;
    const payload = nativeInputBuffer.subarray(4, 4 + length).toString("utf8");
    nativeInputBuffer = nativeInputBuffer.subarray(4 + length);
    try {
      queueOrSend(JSON.parse(payload));
    } catch (error) {
      writeNativeMessage({
        type: "error",
        error: `Native relay received invalid JSON: ${error.message}`,
      });
    }
  }
}

function reportDaemonError(message) {
  const now = Date.now();
  if (now - lastDaemonErrorAt < 3000) return;
  lastDaemonErrorAt = now;
  writeNativeMessage({
    type: "boot_error",
    stage: "daemon_connection",
    error: message,
    daemonSocketPath: DAEMON_SOCKET_PATH,
  });
}

function scheduleDaemonReconnect() {
  if (ending || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectDaemon();
  }, 1500);
}

function connectDaemon() {
  if (ending || connected || (daemonSocket && !daemonSocket.destroyed)) return;
  const socket = net.createConnection(DAEMON_SOCKET_PATH);
  daemonSocket = socket;
  socket.setEncoding("utf8");

  const timer = setTimeout(() => {
    if (connected) return;
    reportDaemonError(
      "Claude Sidebar daemon 未运行。请在 Terminal 执行 start-sidebar-daemon.sh；relay 会自动等待 daemon 恢复。",
    );
    try { socket.destroy(); } catch {}
  }, CONNECT_TIMEOUT_MS);

  socket.on("connect", () => {
    clearTimeout(timer);
    connected = true;
    flushQueue();
  });

  socket.on("data", (chunk) => {
    daemonLineBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = daemonLineBuffer.indexOf("\n")) !== -1) {
      const line = daemonLineBuffer.slice(0, newlineIndex).trim();
      daemonLineBuffer = daemonLineBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        writeNativeMessage(JSON.parse(line));
      } catch (error) {
        writeNativeMessage({
          type: "error",
          error: `Daemon relay received invalid JSON: ${error.message}`,
        });
      }
    }
  });

  socket.on("error", (error) => {
    clearTimeout(timer);
    if (!connected) {
      reportDaemonError(
        `无法连接 Claude Sidebar daemon：${error.message}。请在 Terminal 执行 start-sidebar-daemon.sh；relay 会自动重试。`,
      );
    }
  });

  socket.on("close", () => {
    clearTimeout(timer);
    const wasConnected = connected;
    connected = false;
    daemonSocket = null;
    if (!ending && wasConnected) {
      reportDaemonError(
        "Claude Sidebar daemon 已退出。请在 Terminal 重新启动 daemon；relay 会保持连接并自动恢复。",
      );
    }
    scheduleDaemonReconnect();
  });
}

process.stdin.on("data", (chunk) => {
  nativeInputBuffer = Buffer.concat([nativeInputBuffer, chunk]);
  parseNativeMessages();
});

process.stdin.on("end", () => {
  ending = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try { daemonSocket?.end(); } catch {}
  process.exit(0);
});

process.on("SIGTERM", () => {
  ending = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try { daemonSocket?.destroy(); } catch {}
  process.exit(0);
});

process.on("SIGINT", () => {
  ending = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try { daemonSocket?.destroy(); } catch {}
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  process.stderr.write(`${errorText(error)}\n`);
  try {
    writeNativeMessage({ type: "error", error: errorText(error) });
  } catch {}
  process.exit(1);
});

connectDaemon();
