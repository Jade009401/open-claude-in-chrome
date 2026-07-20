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

  callTool(tool, args = {}) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ id, type: 'tool_request', tool, args })}\n`);
    });
  }

  map(args) { return this.callTool('browser_map', args); }
  locate(args) { return this.callTool('browser_locate', args); }
  read(args) { return this.callTool('browser_read', args); }
  act(args) { return this.callTool('browser_act', args); }
  close() { try { this.socket?.destroy(); } catch {} }
}

export { BrowserClient, unwrap };
