// 侧栏 /qa 命令处理器(QA 逻辑放这;chat-native-host 只做薄拦截)。
// 侧栏输入 /qa <PRD链接> [被测页URL] → 跑 runTask,进度/人审/结果经 emit 回显侧栏。
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from './lark-client.mjs';
import { loadQaConfig } from './config.mjs';
import { BrowserClient } from './browser-client.mjs';
import { runTask } from './orchestrator.mjs';
import { buildRealDeps } from './task-deps.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = join(HERE, '..', 'mcp-server.js');
const PORT = Number(process.env.CLAUDE_SIDEBAR_MCP_PORT || 18765);

// —— 命令识别/解析(纯函数)——
function isQaCommand(text) {
  return /^\/qa(\s|$)/.test(String(text || '').trim());
}
function parseQaCommand(text) {
  const parts = String(text || '').trim().split(/\s+/);
  return { prdUrl: parts[1] || null, targetUrl: parts[2] || null };
}

// —— 人审"等确认"状态:下一条侧栏消息作为回答 ——
let pendingConfirm = null;
function hasPending() { return Boolean(pendingConfirm); }
function answer(text) {
  if (!pendingConfirm) return false;
  const r = pendingConfirm;
  pendingConfirm = null;
  r(String(text || '').trim().toLowerCase());
  return true;
}
function awaitReply() { return new Promise((resolve) => { pendingConfirm = resolve; }); }

// —— 确保有个 mcp-server primary(端口空则 spawn,stdin 保持打开不 EOF 以保活)——
function portOpen(port) {
  return new Promise((res) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
  });
}
async function ensurePrimary() {
  if (await portOpen(PORT)) return null; // 已有 primary,复用
  const child = spawn(process.execPath, [MCP_SERVER], {
    env: { ...process.env, CLAUDE_SIDEBAR_EXPECTED_VERSION: '0.15.3', CLAUDE_SIDEBAR_EXPECTED_PROTOCOL: '13' },
    stdio: ['pipe', 'ignore', 'ignore'], // stdin 不 end → mcp-server 保活
  });
  child.unref?.();
  return child;
}

// 主入口:侧栏跑一次 QA。emit = { status(label), message(text), done() }。
async function runQaInSidebar(text, emit) {
  const { prdUrl, targetUrl } = parseQaCommand(text);
  if (!prdUrl) { emit.message('用法: /qa <PRD链接> [被测页URL]'); emit.done(); return; }
  const cfg = loadQaConfig();
  const client = createClient();
  let primaryChild = null;
  let bc = null;
  try {
    emit.status('QA:读需求 + 生成脚本…');
    if (targetUrl) {
      primaryChild = await ensurePrimary();
      bc = new BrowserClient();
      await bc.connect();
      emit.status(`QA:建图 ${targetUrl} …`);
      await bc.map({ pageQuery: targetUrl });
    }
    const deps = buildRealDeps({
      client, cfg, targetUrl, bc,
      reviewScript: async (script) => {
        const lines = ['===== 待人审脚本 =====', `routeKey: ${script.routeKey}`, `需求: ${JSON.stringify(script.requirementIds)}`];
        (script.steps || []).forEach((s, i) => lines.push(`  ${i + 1}. [${s.action}] ${s.target} 期望=${s.expected} (${s.requirementId})`));
        lines.push('回复 y 确认执行 / n 否决');
        emit.message(lines.join('\n'));
        const a = await awaitReply();
        return { approved: a === 'y', script };
      },
      confirm: async (s) => {
        emit.message(`⚠️ 写操作 [${s.action} ${s.target}] 回复 y 确认 / n 跳过`);
        return (await awaitReply()) === 'y';
      },
    });
    const r = await runTask(prdUrl, deps);
    emit.message(r.ok
      ? `✅ 完成 ${r.routeKey}｜通过 ${r.summary?.pass}/失败 ${r.summary?.fail}/不确定 ${r.summary?.uncertain}｜耗时 ${r.durationMs}ms｜已写结果表 + 播报群`
      : `⛔ 中止(${r.stage || ''}):${r.reason || ''}`);
  } catch (e) {
    emit.message(`QA 异常:${e?.message || e}`);
  } finally {
    try { bc?.close(); } catch {}
    try { primaryChild?.kill(); } catch {}
    emit.done();
  }
}

export { isQaCommand, parseQaCommand, hasPending, answer, runQaInSidebar };
