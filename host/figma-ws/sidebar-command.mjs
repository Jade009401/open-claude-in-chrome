// 侧栏 /figma-ws 命令(独立于 REST 的 /figma):全自动抓当前 Figma tab 的 WS fig-kiwi 帧 →
// host 解码 → 按 URL node-id 抽子树 → 去噪 → 把设计"加载"进当前开发会话(不自动开发)。
// 抓帧复用现成浏览器工具桥(mcp-server ↔ background):BrowserClient 调内部工具 __pure_map_figma_ws_capture。
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BrowserClient } from '../qa/browser-client.mjs';
import { readWsDesignFromBundle } from './ws-design.mjs';
import { buildDevPrompt, buildLoadContext } from '../figma/prompt-gen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = path.join(HERE, '..', 'mcp-server.js');
const PORT = Number(process.env.CLAUDE_SIDEBAR_MCP_PORT || 18765);
const CAPTURE_TOOL = '__pure_map_figma_ws_capture';
// background 对内部工具强制要这三个标记(见 isAuthorizedInternalTool);缺一律拒。
const INTERNAL_MARKERS = { __pureMapInternal: true, __internalRoute: 'pure-map-internal-v1', __protocolVersion: 13 };

function isFigmaWsCommand(text) {
  return /^\/figma-ws(\s|$)/.test(String(text || '').trim());
}
function parseFigmaWsCommand(text) {
  const rest = String(text || '').trim().replace(/^\/figma-ws\s*/, '').trim();
  return { pageName: rest || null };
}
// 从 figma URL 抽 node-id(保留 "sessionID-localID" 原形,下游 nodeIdToKey 转冒号)。
function parseNodeId(url) {
  const raw = (String(url || '').match(/[?&]node-id=([^&]+)/) || [])[1];
  return raw ? decodeURIComponent(raw) : null;
}

// 不再需要指定项目 → 无前端仓库校验、无 cwd 追问。hasPending/answer 保留为常假桩(chat-native-host 仍引用)。
function hasPending() { return false; }
function answer() { return false; }

// —— 确保有 mcp-server primary(端口空则 spawn,stdin 不 EOF 保活),与 /qa 同法 ——
function portOpen(port) {
  return new Promise((res) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
  });
}
async function ensurePrimary() {
  if (await portOpen(PORT)) return null;
  const child = spawn(process.execPath, [MCP_SERVER], {
    env: { ...process.env, CLAUDE_SIDEBAR_EXPECTED_VERSION: '0.15.3', CLAUDE_SIDEBAR_EXPECTED_PROTOCOL: '13' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.unref?.();
  return child;
}

// 主入口:emit={status,message,done};pageContext=当前 Figma 页{tabId,url};deps={cwd, inject(repo,prompt)}。
async function runFigmaWsInSidebar(text, emit, pageContext = null, { cwd = '', inject } = {}) {
  const url = pageContext?.url || '';
  const tabId = pageContext && Number(pageContext.tabId) ? Number(pageContext.tabId) : null;
  const nodeId = parseNodeId(url);
  if (!/figma\.com/i.test(url) || !nodeId) {
    emit.message('请先在 Figma 里打开并**选中**要开发的那一屏(地址栏出现 node-id),再在该 Figma 标签页发 /figma-ws。');
    emit.done();
    return;
  }
  const { pageName } = parseFigmaWsCommand(text);
  let browser = null;
  try {
    // 1) 全自动抓帧(可能自动刷新该 Figma 页以抢初始全量帧)
    emit.status('Figma-WS:连接浏览器通道…');
    await ensurePrimary();
    browser = new BrowserClient();
    await browser.connect();
    emit.status('Figma-WS:抓取设计数据帧(首次会自动刷新该页;大文件首次可能 1–3 分钟,之后秒出)…');
    const res = await browser.callTool(CAPTURE_TOOL, { tabId: tabId || undefined, ...INTERNAL_MARKERS });
    const bundle = res?.bundle;
    if (!bundle?.frames?.length) throw new Error(res?.error || '未抓到 WS 帧');

    // 2) 解码 + 按 node-id 抽子树 + 去噪
    emit.status(`Figma-WS:解码 + 抽取 node ${nodeId} 子树…`);
    const { design, palette, componentList, nodeCount } = readWsDesignFromBundle(bundle, nodeId);

    // 3) 生成开发提示词,直接发给用户;同时把设计注入会话上下文(供后续追问 Claude 记得这份设计)。
    const name = pageName || design?.name || '页面';
    emit.status('Figma-WS:生成开发提示词…');
    const devPrompt = buildDevPrompt({ design, componentList, palette, pageName });
    // 整段提示词包进一个代码块(从"你是资深前端工程师"起全程等宽,统一不散);标题行在块外当抬头。
    emit.message(`【Figma 设计「${name}」→ 前端开发提示词(${nodeCount} 节点)】\n\n\`\`\`\n${devPrompt}\n\`\`\``);
    if (inject) {
      // 注入为会话背景:Claude 记住这份设计以回答追问,但不主动写代码(提示词已发给用户)。不绑定项目,cwd 用侧栏当前值。
      const primer = `${buildLoadContext({ design, componentList, palette, pageName })}\n\n(上面的前端开发提示词已发给用户。现在只回复一句"设计已就绪,可以追问",等用户提问或明确说开发再动手。)`;
      inject(cwd, primer);
    }
  } catch (e) {
    emit.message(`Figma-WS 读取/加载失败:${String(e?.message || e)}`);
  } finally {
    try { browser?.close(); } catch {}
    emit.done();
  }
}

export { isFigmaWsCommand, parseFigmaWsCommand, parseNodeId, hasPending, answer, runFigmaWsInSidebar };
