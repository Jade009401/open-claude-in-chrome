// 侧栏 /qa 命令处理器(QA 逻辑放这;chat-native-host 只做薄拦截)。
// 侧栏输入 /qa <PRD链接> [被测页URL] → 跑 runTask,进度/人审/结果经 emit 回显侧栏。
// 被测入口默认从 PRD 抽(script.entryUrl);[被测页URL] 仅作 PRD 没写时的兜底覆盖。
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from './lark-client.mjs';
import { loadQaConfig } from './config.mjs';
import { BrowserClient } from './browser-client.mjs';
import { runTask } from './orchestrator.mjs';
import { buildRealDeps } from './task-deps.mjs';
import { formatRunResult } from './report.mjs';
import * as systemsMemory from './systems-memory.mjs';

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

// —— 中止原因 → 人话 + 下一步(融入对话,别甩生硬错误码)——
const STAGE_LABEL = {
  generate: '生成脚本', app_gate: '环境门槛', review: '人审',
  entry: '定位入口', prepare: '建图', replay: '重放', routing: '路由',
};
function stageLabel(stage) { return STAGE_LABEL[stage] || stage || ''; }

function humanizeError(r) {
  const code = r?.error?.code || '';
  const reason = typeof r?.reason === 'string'
    ? r.reason
    : (Array.isArray(r?.reason) ? r.reason.join('; ') : '');
  if (code === 'no_target' || reason.includes('no_target') || code === 'no_entry_url' || reason.includes('no_entry_url') || reason.includes('被测入口')) {
    return '没找到被测页面。请先在浏览器打开被测页(登录后进到目标页)再发 /qa,或用 `/qa <PRD链接> <被测页URL>` 手动指定。';
  }
  if (code === 'invalid_url') {
    return '被测页地址不是合法 URL。检查 PRD 里的入口地址,或用 `/qa <PRD链接> <被测页URL>` 手动指定。';
  }
  if (code === 'env_not_whitelisted') {
    return '被测地址不在测试环境白名单(疑似生产,已拒绝)。请换测试环境地址,或在 qa-config 的 envWhitelist 里加白名单。';
  }
  if (code === 'app_env_not_ready') {
    return '这是原生 App 场景,移动自动化环境没配置(Phase 0 只做网页端),已跳过。';
  }
  if (reason.includes('路由总表无此键') || (r?.stage === 'routing' && reason.includes('路由'))) {
    return `路由总表没匹配这个系统的行(${reason})。请先在「QA路由总表」加一行:端 / 系统模块 / 结果表链接 / 播报群名。`;
  }
  if (r?.stage === 'generate') {
    return `AI 生成的脚本没通过校验:${reason || '未产出合法 JSON'}。多半是 PRD 需求或被测入口写得不够清楚,补一下再跑。`;
  }
  if (r?.stage === 'review') return '你否决了脚本,已中止。';
  return reason || code || '未知原因';
}

// —— 人审"等确认"状态:下一条侧栏消息作为回答 ——
let pendingConfirm = null;
function hasPending() { return Boolean(pendingConfirm); }
function answer(text) {
  if (!pendingConfirm) return false;
  const r = pendingConfirm;
  pendingConfirm = null;
  r(String(text || '').trim()); // 不小写:人审可能粘深链 URL,大小写敏感
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
// pageContext = { tabId, url, title }:侧栏当前打开的页(默认被测目标,固定 tabId)。
async function runQaInSidebar(text, emit, pageContext = null) {
  const { prdUrl, targetUrl } = parseQaCommand(text);
  if (!prdUrl) { emit.message('用法: /qa <PRD链接>(默认测你当前打开的页面;也可 /qa <PRD链接> <被测页URL> 手动指定)'); emit.done(); return; }
  const cfg = loadQaConfig();
  const client = createClient();
  const pinnedTab = pageContext && Number(pageContext.tabId) ? { tabId: Number(pageContext.tabId), url: String(pageContext.url || '') } : null;
  // 人审时展示被测目标来源(记忆命中 → 自动导航;首次 → 测当前页并沉淀)。
  const describeTarget = (script) => {
    const fm = script.featureMenu || '';
    const hit = systemsMemory.lookup(script.routeKey, fm);
    if (targetUrl) return `手输深链 → 自动导航 ${targetUrl}(会记住)`;
    if (hit?.url) return `记忆命中「${fm}」→ 自动导航 ${hit.url}`;
    if (script.entryUrl) return `PRD 入口 → 自动导航 ${script.entryUrl}(会记住)`;
    if (pinnedTab) return `⚠️ 无深链,默认测当前页 ${pinnedTab.url || `tab#${pinnedTab.tabId}`} —— 若这不是被测功能页,回复功能页深链 URL 纠正(会记住)`;
    return '(无当前页/URL,将中止)';
  };
  let primaryChild = null;
  let deps = null;
  try {
    // 浏览器懒起:定了目标、要建图时才拉起 primary + 连通道。
    const connectBrowser = async () => {
      primaryChild = await ensurePrimary();
      const browser = new BrowserClient();
      await browser.connect();
      return browser;
    };
    deps = buildRealDeps({
      client, cfg,
      connectBrowser,
      pinnedTab,
      entryUrlOverride: targetUrl,
      onProgress: (label) => emit.status(`QA:${label}`),
      reviewScript: async (script) => {
        const lines = [
          '===== 待人审脚本 =====',
          `routeKey: ${script.routeKey}`,
          `功能菜单: ${script.featureMenu || '(未标)'}`,
          `被测目标: ${describeTarget(script)}`,
          `需求: ${JSON.stringify(script.requirementIds)}`,
        ];
        (script.steps || []).forEach((s, i) => lines.push(`  ${i + 1}. [${s.action}] ${s.target} 期望=${s.expected} (${s.requirementId})`));
        lines.push('回复 y 确认执行 / n 否决 / 或粘功能页深链 URL(用它替代上面目标,并记住)');
        emit.message(lines.join('\n'));
        const a = await awaitReply();
        if (/^https?:\/\//i.test(a)) return { approved: true, script, overrideUrl: a.trim() };
        return { approved: a.toLowerCase() === 'y', script };
      },
      confirm: async (s) => {
        emit.message(`⚠️ 写操作 [${s.action} ${s.target}] 回复 y 确认 / n 跳过`);
        return (await awaitReply()).toLowerCase() === 'y';
      },
      onLoginRequired: async (url) => {
        emit.message(`🔐 检测到登录页(会话可能过期):${url}\n请在浏览器登录后回复 ok 继续。`);
        await awaitReply();
      },
    });
    emit.status('QA:读需求 + 生成脚本…');
    const r = await runTask(prdUrl, deps);
    // 跑完(含路由降级)→ 结果块直接显示;真失败(生成/人审/建图/重放阶段)→ 人话报错。
    if (r.ok) emit.message(`\`\`\`\n${formatRunResult(r)}\n\`\`\``);
    else emit.message(`⛔ 没跑完(${stageLabel(r.stage)}):${humanizeError(r)}`);
  } catch (e) {
    emit.message(`QA 异常:${e?.message || e}`);
  } finally {
    try { deps?.closeBrowser(); } catch {}
    try { primaryChild?.kill(); } catch {}
    emit.done();
  }
}

export { isQaCommand, parseQaCommand, hasPending, answer, humanizeError, stageLabel, runQaInSidebar };
