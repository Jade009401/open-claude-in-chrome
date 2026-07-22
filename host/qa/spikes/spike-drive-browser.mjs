// Task 0b spike:验证 host 编排器能否作为「独立 TCP client」驱动 map/locate/act。
// 只读:仅跑 browser_map + browser_locate + 纯本地 locate import,不做 act/写操作。
//
// 前置:需有一个运行中的 primary mcp-server(监听 18765)+ native-host + extension 已连
//       (即侧栏有活跃 Claude 会话)。本 spike 以第二个 client 身份连上去,验证多 client 并存。
//
// 用法:node host/qa/spikes/spike-drive-browser.mjs ["页面标题关键词(pageQuery)"] ["locate查询词"]
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { locateInMap } from '../../search/navigation-search.mjs';
import { MapEngine } from '../../map/map-engine.mjs';

const VERSION = '0.15.3';
const PROTOCOL_VERSION = 13;
const DEFAULT_PORT = 18765;

function getPort() {
  const env = Number(process.env.CLAUDE_SIDEBAR_MCP_PORT || 0);
  if (Number.isInteger(env) && env > 0 && env < 65536) return env;
  try {
    const value = Number(
      JSON.parse(
        fs.readFileSync(
          path.join(os.homedir(), '.config', 'open-claude-in-chrome', 'config.json'),
          'utf8',
        ),
      ).port,
    );
    if (Number.isInteger(value) && value > 0 && value < 65536) return value;
  } catch {}
  return DEFAULT_PORT;
}

const PORT = getPort();
const PAGE_QUERY = process.argv[2] || '产品实施说明'; // 用户已打开的 Lark 页标题关键词
const LOCATE_QUERY = process.argv[3] || '服务范围'; // 该文档里的一个章节词

// ── Part A:纯本地 locate import 契约验证(0b Step2/3①,不碰网络)──────────
function verifyLocalLocateImport() {
  const results = {
    locateInMap_isFn: typeof locateInMap === 'function',
    MapEngine_instance_locate_isFn: typeof new MapEngine().locate === 'function',
  };
  console.log('[0b/A] 纯本地 locate import 契约:');
  console.log(`  - import { locateInMap } 是函数: ${results.locateInMap_isFn}`);
  console.log(`  - new MapEngine().locate 是函数: ${results.MapEngine_instance_locate_isFn}`);
  console.log(
    `  → 结论:两条候选都可用;推荐直接 import locateInMap(真正纯函数,不构造 MapStore/BuildLock)。`,
  );
  return results;
}

// MCP 工具结果是 { content:[{type:'text', text:'<json>'}] };真正 payload 在 text 里。
function unwrap(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text === 'string') {
    try { return JSON.parse(text); } catch { return { _raw: text }; }
  }
  return result || {};
}

// ── Part B:作为 TCP client 驱动 map/locate ────────────────────────────────
function driveViaClient() {
  return new Promise((resolve) => {
    let socket = null;
    let buffer = Buffer.alloc(0);
    let nextId = 1;
    let settled = false;
    const pending = new Map(); // id -> {resolve, reject, tool}
    const observations = { connected: false, clientAck: null, map: null, locate: null };
    const connectDeadline = Date.now() + 20000; // 最多重试连 20s 等 primary 起来

    // 超时兜底:browser_map 首建可能较久。
    const hardTimer = setTimeout(() => {
      console.log('[0b/B] ⏱️ 超时(120s)未跑完,可能 extension 未就绪或页面未打开。');
      cleanup(observations);
    }, 120000);

    function cleanup(result) {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try { socket?.destroy(); } catch {}
      resolve(result);
    }

    function send(obj) {
      socket.write(`${JSON.stringify(obj)}\n`);
    }

    function callTool(tool, args) {
      const id = String(nextId++);
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej, tool });
        send({ id, type: 'tool_request', tool, args });
        console.log(`[0b/B] → tool_request ${tool} id=${id} args=${JSON.stringify(args)}`);
      });
    }

    function handle(msg) {
      if (msg.type === 'client_ack') {
        observations.connected = true;
        observations.clientAck = { clientId: msg.clientId, compatible: msg.compatible };
        console.log(
          `[0b/B] ✅ client_ack clientId=${msg.clientId} compatible=${msg.compatible}`,
        );
        runSequence();
        return;
      }
      if (!msg.id) return;
      const entry = pending.get(String(msg.id));
      if (!entry) return;
      if (msg.type === 'tool_progress') {
        console.log(`[0b/B]   … progress id=${msg.id} ${JSON.stringify(msg.progress || {})}`);
        return; // 进度不结算
      }
      pending.delete(String(msg.id));
      if (msg.type === 'tool_error') {
        console.log(`[0b/B] ❌ tool_error id=${msg.id} tool=${entry.tool}: ${msg.error}`);
        entry.reject(new Error(msg.error || 'tool_error'));
      } else {
        entry.resolve(msg.result);
      }
    }

    async function runSequence() {
      try {
        // 1) browser_map:按标题关键词定位那篇 Lark 页并建/取图。
        const mapRes = unwrap(await callTool('browser_map', { pageQuery: PAGE_QUERY }));
        observations.map = { ok: mapRes.ok, mapId: mapRes.mapId, title: mapRes.page?.title, url: mapRes.page?.url };
        console.log(
          `[0b/B] ✅ browser_map ok=${mapRes.ok} mapId=${mapRes.mapId} title="${mapRes.page?.title}" ` +
            `anchors=${mapRes.status?.anchorCount ?? mapRes.anchorCount ?? '?'}`,
        );

        // 2) browser_locate:在该页地图里试几个查询词,看是否返回真实候选(解开 MCP wrapper)。
        const queries = process.argv.slice(3).length
          ? process.argv.slice(3)
          : [LOCATE_QUERY, '服务', '概述', '服务内容', '改造设计'];
        observations.locate = [];
        for (const q of queries) {
          const loc = unwrap(await callTool('browser_locate', { query: q, pageQuery: PAGE_QUERY, limit: 5 }));
          const matches = loc.matches || loc.candidates || [];
          const n = Array.isArray(matches) ? matches.length : null;
          observations.locate.push({ q, n });
          console.log(
            `[0b/B] locate "${q}" → ${n} 候选` +
              (matches[0] ? `,首个: ${JSON.stringify(matches[0]).slice(0, 160)}` : ''),
          );
        }
        cleanup(observations);
      } catch (err) {
        console.log(`[0b/B] 序列中断: ${err.message}`);
        cleanup(observations);
      }
    }

    function attemptConnect() {
      if (settled) return;
      socket = net.createConnection({ host: '127.0.0.1', port: PORT });
      socket.once('connect', () => {
        console.log(`[0b/B] TCP 已连 127.0.0.1:${PORT},发 client_hello`);
        send({ type: 'client_hello', version: VERSION, protocolVersion: PROTOCOL_VERSION });
      });
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        let idx;
        while ((idx = buffer.indexOf(10)) >= 0) {
          const line = buffer.subarray(0, idx).toString('utf8').trim();
          buffer = buffer.subarray(idx + 1);
          if (!line) continue;
          try { handle(JSON.parse(line)); } catch {}
        }
      });
      socket.on('error', (err) => {
        if (observations.connected || settled) return;
        if (Date.now() < connectDeadline) {
          console.log(`[0b/B] 连接未就绪(${err.code || err.message}),700ms 后重试…`);
          setTimeout(attemptConnect, 700);
        } else {
          console.log(`[0b/B] ❌ 20s 内连不上 18765(primary 未起?): ${err.message}`);
          cleanup(observations);
        }
      });
    }
    attemptConnect();
  });
}

async function main() {
  console.log(`[0b] 端口=${PORT} 目标页关键词="${PAGE_QUERY}" locate查询="${LOCATE_QUERY}"`);
  verifyLocalLocateImport();
  console.log('');
  const obs = await driveViaClient();
  console.log('');
  console.log('[0b] 观察小结:');
  console.log(`  - client 连接/ack: ${obs.connected ? '成功' : '失败'}`);
  console.log(`  - browser_map: ${obs.map ? '有返回' : '无'}`);
  console.log(`  - browser_locate: ${obs.locate ? '有返回' : '无'}`);
  console.log('  - ⚠️ 请人工观察:运行期间 Chrome 是否弹「自动化控制」横幅?侧栏会话是否被挤断?');
}

main().catch((e) => {
  console.log(`[0b] 异常: ${e?.message || e}`);
  process.exitCode = 1;
});
