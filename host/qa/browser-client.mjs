// 浏览器通道客户端(把 0b 验证过的接法封成可复用类)。
// 作为独立 TCP client 连 mcp-server primary(18765),驱动 browser_map/locate/read/act。
// 供 replayer 的 deps.locate/act 用。
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const VERSION = '0.15.3';
const PROTOCOL_VERSION = 13;
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

// MCP 工具结果 { content:[{text:'<json>'}] } → 解出真实 payload。
function unwrap(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text === 'string') { try { return JSON.parse(text); } catch { return { _raw: text }; } }
  return result || {};
}

class BrowserClient {
  constructor() {
    this.port = getPort();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.acked = false;
  }

  // 连上 primary(带重试等它起来)。
  connect({ timeoutMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const attempt = () => {
        const socket = net.createConnection({ host: '127.0.0.1', port: this.port });
        this.socket = socket;
        socket.once('connect', () => {
          socket.write(`${JSON.stringify({ type: 'client_hello', version: VERSION, protocolVersion: PROTOCOL_VERSION })}\n`);
        });
        socket.on('data', (chunk) => {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          let idx;
          while ((idx = this.buffer.indexOf(10)) >= 0) {
            const line = this.buffer.subarray(0, idx).toString('utf8').trim();
            this.buffer = this.buffer.subarray(idx + 1);
            if (!line) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
            if (msg.type === 'client_ack') { this.acked = true; resolve(this); continue; }
            if (!msg.id) continue;
            if (msg.type === 'tool_progress') continue;
            const entry = this.pending.get(String(msg.id));
            if (!entry) continue;
            this.pending.delete(String(msg.id));
            if (msg.type === 'status') { entry.resolve(msg); continue; } // 就绪查询回复:整条返回(含 ready 等)
            if (msg.type === 'tool_error') entry.reject(new Error(msg.error || 'tool_error'));
            else entry.resolve(unwrap(msg.result));
          }
        });
        socket.on('error', () => {
          if (this.acked) return;
          if (Date.now() < deadline) setTimeout(attempt, 700);
          else reject(new Error(`无法连上 mcp-server primary(:${this.port})——请确保侧栏会话在跑,或先自持 primary`));
        });
      };
      attempt();
    });
  }

  callTool(tool, args = {}, { timeoutMs = 240000 } = {}) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`callTool 超时(${Math.round(timeoutMs / 1000)}s):${tool}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.socket.write(`${JSON.stringify({ id, type: 'tool_request', tool, args })}\n`);
    });
  }

  // 查一次 transport 就绪状态(不触发扩展,primary 直接回)。
  status({ timeoutMs = 5000 } = {}) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error('status 超时')); }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.socket.write(`${JSON.stringify({ id, type: 'status' })}\n`);
    });
  }

  // 轮询等浏览器传输就绪(native-host 桥接上 primary + 收到 extension_hello);超时抛 browser_transport_unavailable。
  async waitReady({ timeoutMs = 45000, intervalMs = 1000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try { last = await this.status(); if (last?.ready) return true; } catch {}
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    const e = new Error(`浏览器传输未就绪(等 ${Math.round(timeoutMs / 1000)}s):native-host/扩展未连上${last ? `(state=${last.recoveryState} nativeHost=${last.nativeHostConnected} extHello=${last.extensionReady})` : ''}`);
    e.code = 'browser_transport_unavailable';
    throw e;
  }

  map(args) { return this.callTool('browser_map', args); }
  locate(args) { return this.callTool('browser_locate', args); }
  read(args) { return this.callTool('browser_read', args); }
  act(args) { return this.callTool('browser_act', args); }
  navigate(args) { return this.callTool('navigate', args); } // 把指定 tab 导到 URL(复用会话)
  pageContext(args) { return this.callTool('__pure_map_page_context', args); } // 读当前页真实 URL(检测重定向到登录页)
  close() { try { this.socket?.destroy(); } catch {} }
}

export { BrowserClient, unwrap };
