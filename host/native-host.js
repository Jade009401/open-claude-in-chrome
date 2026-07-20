#!/usr/bin/env node
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const VERSION = '0.15.3';
const DEFAULT_PORT = 18765;
function getPort() {
  const env = Number(process.env.CLAUDE_SIDEBAR_MCP_PORT || 0);
  if (Number.isInteger(env) && env > 0 && env < 65536) return env;
  try {
    const value = Number(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'open-claude-in-chrome', 'config.json'), 'utf8')).port);
    if (Number.isInteger(value) && value > 0 && value < 65536) return value;
  } catch {}
  return DEFAULT_PORT;
}
const PORT = getPort();
let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let tcpBuffer = Buffer.alloc(0);
let stdinBuffer = Buffer.alloc(0);
let stopping = false;
let heartbeatTimer = null;
let lastConnectErrorAt = 0;
let suppressedConnectErrors = 0;
let latestExtensionHello = null;
let extensionHelloReplayCount = 0;
const outboundQueue = [];

function writeNative(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}
function socketReady() {
  return Boolean(socket && !socket.destroyed && socket.writable && socket.connecting !== true && socket.pending !== true);
}
function writeLine(message) {
  const line = `${JSON.stringify(message)}\n`;
  if (socketReady()) {
    try { socket.write(line); return true; } catch {}
  }
  outboundQueue.push(line);
  if (outboundQueue.length > 500) outboundQueue.splice(0, outboundQueue.length - 500);
  return false;
}
function flushQueue() {
  if (!socketReady()) return;
  while (outboundQueue.length) {
    const line = outboundQueue.shift();
    try { socket.write(line); } catch { outboundQueue.unshift(line); break; }
  }
}
function rememberExtensionHello(message) {
  if (!message || message.type !== 'extension_hello') return false;
  latestExtensionHello = { ...message };
  return true;
}
function replayExtensionHello(reason = 'tcp_reconnect') {
  if (!latestExtensionHello) return false;
  extensionHelloReplayCount += 1;
  return writeLine({
    ...latestExtensionHello,
    replayed: true,
    replayReason: reason,
    replayCount: extensionHelloReplayCount,
    replayedAt: new Date().toISOString(),
  });
}
function processTcp(chunk) {
  tcpBuffer = Buffer.concat([tcpBuffer, chunk]);
  let index;
  while ((index = tcpBuffer.indexOf(10)) >= 0) {
    const line = tcpBuffer.subarray(0, index).toString('utf8').trim();
    tcpBuffer = tcpBuffer.subarray(index + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (message?.type === 'request_extension_hello') {
        if (!replayExtensionHello('mcp_request')) writeNative(message);
        continue;
      }
      writeNative(message);
    } catch {}
  }
}
function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  const delay = Math.min(5000, 250 + reconnectAttempt * 250) + Math.floor(Math.random() * 250);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}
function connect() {
  if (stopping || (socket && !socket.destroyed)) return;
  const candidate = net.createConnection({ host: '127.0.0.1', port: PORT });
  socket = candidate;
  candidate.once('connect', () => {
    reconnectAttempt = 0;
    if (suppressedConnectErrors) {
      process.stderr.write(`Claude Sidebar native host TCP connection recovered after suppressing ${suppressedConnectErrors} repeated errors.\n`);
      suppressedConnectErrors = 0;
    }
    writeLine({ type: 'native_hello', version: VERSION, protocolVersion: 13, pid: process.pid });
    // The MCP server is created inside each Claude CLI runtime and can restart
    // while Chrome keeps the same Native Messaging process alive. Replay the
    // latest extension handshake on every TCP connection so a new MCP primary
    // never remains stuck in waiting_for_extension.
    replayExtensionHello('tcp_connect');
    flushQueue();
    if (!heartbeatTimer) { heartbeatTimer = setInterval(() => writeLine({ type: 'heartbeat', version: VERSION, at: new Date().toISOString() }), 10000); heartbeatTimer.unref?.(); }
  });
  candidate.on('data', processTcp);
  candidate.on('error', (error) => {
    const now = Date.now();
    if (now - lastConnectErrorAt >= 5000) {
      const suppressed = suppressedConnectErrors ? ` (${suppressedConnectErrors} repeated errors suppressed)` : '';
      process.stderr.write(`Claude Sidebar native host TCP error: ${error.message}${suppressed}\n`);
      lastConnectErrorAt = now;
      suppressedConnectErrors = 0;
    } else {
      suppressedConnectErrors += 1;
    }
  });
  candidate.on('close', () => {
    if (socket === candidate) socket = null;
    scheduleReconnect();
  });
}
function processNativeInput(chunk) {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  while (stdinBuffer.length >= 4) {
    const length = stdinBuffer.readUInt32LE(0);
    if (length > 64 * 1024 * 1024) {
      process.stderr.write(`Native message too large: ${length}\n`);
      process.exit(1);
    }
    if (stdinBuffer.length < 4 + length) return;
    const payload = stdinBuffer.subarray(4, 4 + length);
    stdinBuffer = stdinBuffer.subarray(4 + length);
    try {
      const message = JSON.parse(payload.toString('utf8'));
      if (rememberExtensionHello(message)) {
        // Do not queue extension_hello while the TCP side is down: the cached
        // handshake is replayed first on reconnect, ahead of tool traffic.
        if (socketReady()) writeLine(message);
      } else {
        writeLine(message);
      }
    }
    catch (error) { process.stderr.write(`Invalid native message: ${error.message}\n`); }
  }
}
function shutdown() {
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  try { socket?.destroy(); } catch {}
  process.exit(0);
}
process.stdin.on('data', processNativeInput);
process.stdin.on('end', shutdown);
process.stdin.on('error', shutdown);
for (const signal of ['SIGTERM','SIGINT','SIGHUP']) process.on(signal, shutdown);
connect();
