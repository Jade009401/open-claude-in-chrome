#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { prepareChatMessageAttachments, cleanupOldAttachments, chatAttachmentLimits } from './chat-attachment-store.mjs';
import { createChatContextAuthority } from './chat-context-authority.mjs';
import { PURE_MAP_CLAUDE_TOOL_NAMES, PURE_MAP_SERVER_NAME, validateClaudeToolSurface, formatPureMapToolInventory } from './mcp-tool-surface.mjs';
// QA 侧栏命令(/qa):在 chat 层拦截,跑 host 侧编排器,不转 Claude CLI。逻辑在 host/qa/。
import * as qaSidebar from './qa/sidebar-command.mjs';
// Figma 侧栏命令(/figma):抓当前 Figma tab 选中屏 → 读设计 → 生成前端提示词。逻辑在 host/figma/。
import * as figmaSidebar from './figma/sidebar-command.mjs';
// Figma-WS 侧栏命令(/figma-ws):独立于 REST,全自动拦 WS fig-kiwi 帧 → 解码抽子树 → 加载进会话。逻辑在 host/figma-ws/。
import * as figmaWsSidebar from './figma-ws/sidebar-command.mjs';

const VERSION = '0.15.3';
const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.dirname(HOST_DIR);

// Session history persistence: the preserved sidebar UI lists sessions and
// replays their messages; the CLI takeover previously stubbed both to empty.
// Local disk only; capped at 50 sessions × 200 messages.
const SESSIONS_ROOT = path.join(
  process.env.CLAUDE_SIDEBAR_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeSidebarPureMap'),
  'sessions',
);
function sessionFilePath(sessionId) {
  const safe = String(sessionId || '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
  return path.join(SESSIONS_ROOT, `${safe}.json`);
}
function readSessionRecord(sessionId) {
  try { return JSON.parse(fs.readFileSync(sessionFilePath(sessionId), 'utf8')); } catch { return null; }
}
function appendSessionMessage(sessionId, role, content) {
  const text = String(content || '').trim();
  if (!sessionId || !text) return;
  try {
    fs.mkdirSync(SESSIONS_ROOT, { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    const record = readSessionRecord(sessionId) || { sessionId, title: '', createdAt: now, messages: [] };
    record.updatedAt = now;
    if (!record.title && role === 'user') record.title = text.replace(/\s+/g, ' ').slice(0, 60);
    record.messages.push({ role, content: text.slice(0, 20000), at: now });
    if (record.messages.length > 200) record.messages = record.messages.slice(-200);
    const target = sessionFilePath(sessionId);
    const temp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temp, target);
    pruneSessionFiles();
  } catch (error) { logHost('session_store_write_failed', { error: String(error?.message || error) }); }
}
function pruneSessionFiles() {
  try {
    const entries = fs.readdirSync(SESSIONS_ROOT)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({ name, mtime: fs.statSync(path.join(SESSIONS_ROOT, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const entry of entries.slice(50)) fs.rmSync(path.join(SESSIONS_ROOT, entry.name), { force: true });
  } catch {}
}
function listSessionRecords() {
  try {
    return fs.readdirSync(SESSIONS_ROOT)
      .filter((name) => name.endsWith('.json'))
      .map((name) => { try { return JSON.parse(fs.readFileSync(path.join(SESSIONS_ROOT, name), 'utf8')); } catch { return null; } })
      .filter((record) => record?.sessionId)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  } catch { return []; }
}
// CLI-native session continuity: each sidebar session pins one Claude CLI session
// UUID. Turn 1 creates it with --session-id; turn 2+ resume it with --resume, so
// the CLI's own transcript (tool calls AND their results — the doc content, the
// map) stays in context and the model never re-reads/re-analyses from scratch. The
// pinned cwd keeps every turn in the same project so resume stays valid.
function cliSessionFor(sessionId, requestedCwd) {
  const now = new Date().toISOString();
  const record = readSessionRecord(sessionId) || { sessionId, title: '', createdAt: now, messages: [] };
  if (!record.cliSessionId) record.cliSessionId = randomUUID();
  if (!record.cliCwd && requestedCwd) record.cliCwd = requestedCwd;
  const resume = record.cliStarted === true; // only after a prior turn actually produced a transcript
  try {
    fs.mkdirSync(SESSIONS_ROOT, { recursive: true, mode: 0o700 });
    record.updatedAt = now;
    const target = sessionFilePath(sessionId);
    const temp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temp, target);
  } catch (error) { logHost('cli_session_write_failed', { error: String(error?.message || error) }); }
  return { cliSessionId: record.cliSessionId, cliCwd: record.cliCwd || null, resume };
}
function updateSessionRecord(sessionId, mutate) {
  try {
    const record = readSessionRecord(sessionId);
    if (!record) return;
    mutate(record);
    record.updatedAt = new Date().toISOString();
    const target = sessionFilePath(sessionId);
    const temp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temp, target);
  } catch (error) { logHost('cli_session_update_failed', { error: String(error?.message || error) }); }
}
function markCliSessionStarted(sessionId) {
  updateSessionRecord(sessionId, (record) => { record.cliStarted = true; });
}
// Self-heal: a resume that failed because the transcript is gone/invalid clears the
// pinned id so the NEXT turn starts a fresh CLI session (no same-turn respawn).
function resetCliSession(sessionId) {
  updateSessionRecord(sessionId, (record) => { delete record.cliSessionId; delete record.cliStarted; });
  logHost('cli_session_reset', { sessionId });
}
let stdinBuffer = Buffer.alloc(0);
const active = new Map();
const pendingChats = [];
const contextAuthority = createChatContextAuthority();
let runningRequestId = null;
let currentSessionId = null;
let protocolMode = ['legacy', 'modern'].includes(String(process.env.CLAUDE_SIDEBAR_CHAT_PROTOCOL || '').toLowerCase())
  ? String(process.env.CLAUDE_SIDEBAR_CHAT_PROTOCOL).toLowerCase()
  : 'auto';

function writeNative(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}
function logHost(event, detail = {}) {
  try {
    process.stderr.write(`[${new Date().toISOString()}] ${event} ${JSON.stringify(detail)}\n`);
  } catch {}
}
function detectProtocolMode(message = {}) {
  if (protocolMode !== 'auto') return protocolMode;
  const type = String(message?.type || '').toLowerCase();
  if (['prepare_session', 'new_session', 'select_session', 'resume_session', 'list_sessions', 'get_session_messages', 'send_message', 'user_message', 'chat_message'].includes(type)) {
    protocolMode = 'legacy';
  } else if (type === 'hello') {
    protocolMode = message.clientVersion || message.version || message.sessionId || message.session_id ? 'modern' : 'legacy';
  } else if (type === 'chat') {
    if (message.clientVersion || Array.isArray(message.history)) protocolMode = 'modern';
    else if ('pageContext' in message || 'cwd' in message || 'permissionMode' in message || 'thread' in message) protocolMode = 'legacy';
  }
  if (protocolMode !== 'auto') logHost('chat_protocol_selected', { protocolMode, trigger: type || 'unknown' });
  return protocolMode;
}
function usesLegacyProtocol() {
  return protocolMode === 'legacy';
}
function emitStatus(requestId, label, phase = 'running', detail = '') {
  if (!usesLegacyProtocol()) {
    writeNative({ type: 'status', requestId, label, phase, detail });
    return;
  }
  const toolMatch = String(label || '').match(/^正在执行\s+(.+)$/);
  if (toolMatch) {
    writeNative({ type: 'tool', requestId, name: toolMatch[1], phase, detail });
    return;
  }
  writeNative({ type: 'activity', requestId, activity: 'working', detail: label || detail || 'Claude 正在处理…', phase });
}
function emitAssistantDelta(requestId, text) {
  if (!text) return;
  writeNative(usesLegacyProtocol()
    ? { type: 'delta', requestId, text }
    : { type: 'assistant_delta', requestId, text });
}
function emitAssistantMessage(requestId, text) {
  if (!text) return;
  writeNative(usesLegacyProtocol()
    ? { type: 'local_output', requestId, content: text }
    : { type: 'assistant_message', requestId, text });
}
function emitTurnStarted(requestId, queuedForMs = 0) {
  if (usesLegacyProtocol()) writeNative({ type: 'turn_started', requestId, queuedForMs });
}
function emitQueued(requestId, position) {
  if (usesLegacyProtocol()) writeNative({ type: 'queued', requestId, position });
}
function emitDone(state) {
  if (usesLegacyProtocol()) {
    writeNative({ type: 'done', requestId: state.requestId, sessionId: state.sessionId || null });
  } else {
    writeNative({ type: 'assistant_done', requestId: state.requestId });
  }
}
// 斜杠命令输出(/cost 等):独立类型,侧栏渲染成保留换行的等宽块(不当普通 Markdown)。
function emitCommandOutput(requestId, text, extra = {}) {
  if (!text) return;
  writeNative({ type: 'command_output', requestId, text, ...extra });
}

// ── 斜杠命令 / agent 能力发现 ─────────────────────────────────────
// Claude 的 system/init 事件带 slash_commands(技能/自定义/插件命令)+ agents;
// 侧栏斜杠菜单据此渲染。此前 init 只取了 tools,命令列表一直为空。缓存一次避免重复探。
let cachedCapabilities = null;
function capabilitiesFromInit(event) {
  const slash = Array.isArray(event?.slash_commands) ? event.slash_commands : [];
  const agents = Array.isArray(event?.agents) ? event.agents : [];
  if (!slash.length && !agents.length) return null;
  return {
    type: 'capabilities',
    capabilitiesStatus: 'loaded',
    commands: slash.map((name) => ({ name: String(name) })),
    agents: agents.map((name) => ({ name: String(name) })),
  };
}
function emitCapabilities(event) {
  const caps = capabilitiesFromInit(event);
  if (!caps) return;
  cachedCapabilities = caps;
  writeNative(caps);
}
// 连上/新会话时异步探一次 claude:读到 init 就抽命令、emit、随即 kill(拿到 init 即停,
// 几乎不产 token)。已缓存则直接复用不再 spawn;失败静默(不影响会话)。
function probeCapabilities() {
  if (cachedCapabilities) { writeNative(cachedCapabilities); return; }
  let child;
  try {
    child = spawn(process.env.CLAUDE_SIDEBAR_CLAUDE_BIN || 'claude',
      ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
      { cwd: os.tmpdir(), env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (error) { logHost('capabilities_probe_spawn_failed', { error: String(error) }); return; }
  let buf = '';
  const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 30000);
  const stop = () => { clearTimeout(killer); try { child.kill('SIGKILL'); } catch {} };
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.type === 'system' && event.subtype === 'init') { emitCapabilities(event); stop(); return; }
    }
  });
  child.on('error', (error) => { clearTimeout(killer); logHost('capabilities_probe_error', { error: String(error) }); });
  try { child.stdin.write('hi'); child.stdin.end(); } catch {}
}
function stripManagedClaudeArgs(input) {
  const result = [];
  for (let i = 0; i < input.length; i += 1) {
    const value = input[i];
    if (value === '--strict-mcp-config') continue;
    if (value === '--mcp-config') { i += 1; continue; }
    if (value === '--allowedTools' || value === '--allowed-tools' || value === '--disallowedTools' || value === '--disallowed-tools') {
      while (i + 1 < input.length && !String(input[i + 1]).startsWith('--')) i += 1;
      continue;
    }
    result.push(value);
  }
  return result;
}
function isDirectory(value) {
  try { return Boolean(value) && fs.statSync(value).isDirectory(); } catch { return false; }
}
function resolveExecutable(command, env = process.env) {
  const value = String(command || '').trim();
  if (!value) return null;
  if (path.isAbsolute(value) || value.includes(path.sep)) {
    try { fs.accessSync(value, fs.constants.X_OK); return value; } catch { return null; }
  }
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, value);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return null;
}
function resolveChatCwd(message = {}) {
  const requested = String(message.cwd || '').trim();
  const configured = String(process.env.CLAUDE_SIDEBAR_DEFAULT_CWD || '').trim();
  const candidates = [requested, configured, PROJECT_DIR, os.homedir(), '/tmp', '/'];
  const cwd = candidates.find(isDirectory) || '/';
  return { cwd, requested, requestedMissing: Boolean(requested && !isDirectory(requested)) };
}
function runtimePreflight({ command, mcpConfig, cwd }) {
  const diagnostics = { command, mcpConfig, cwd, missing: [], invalid: [] };
  const resolvedCommand = resolveExecutable(command);
  if (!resolvedCommand) diagnostics.missing.push({ kind: 'claude_binary', path: command });
  if (!isDirectory(cwd)) diagnostics.missing.push({ kind: 'cwd', path: cwd });
  let config = null;
  if (!mcpConfig || !fs.existsSync(mcpConfig)) {
    diagnostics.missing.push({ kind: 'mcp_config', path: mcpConfig || '(empty)' });
  } else {
    try { config = JSON.parse(fs.readFileSync(mcpConfig, 'utf8')); }
    catch (error) { diagnostics.invalid.push({ kind: 'mcp_config_json', path: mcpConfig, error: error.message }); }
  }
  const entry = config?.mcpServers?.[PURE_MAP_SERVER_NAME];
  if (entry) {
    const serverCommand = String(entry.command || '').trim();
    if (serverCommand && !resolveExecutable(serverCommand)) diagnostics.missing.push({ kind: 'mcp_server_command', path: serverCommand });
    for (const arg of Array.isArray(entry.args) ? entry.args : []) {
      const value = String(arg || '');
      if (!value || (!path.isAbsolute(value) && !value.includes(path.sep))) continue;
      if (!fs.existsSync(value)) diagnostics.missing.push({ kind: 'mcp_server_arg', path: value });
    }
  }
  if (diagnostics.missing.length || diagnostics.invalid.length) {
    const error = new Error(`Claude 运行环境缺少文件或路径：${JSON.stringify(diagnostics)}`);
    error.code = 'claude_runtime_preflight_failed';
    error.diagnostics = diagnostics;
    throw error;
  }
  return { resolvedCommand, diagnostics };
}
function resultErrorDetails(event = {}, state = {}) {
  const subtype = String(event.subtype || 'error_during_execution');
  const errors = Array.isArray(event.errors) ? event.errors.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const candidates = [event.result, event.error, event.message?.error, ...errors, state.stderr]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return {
    code: 'claude_cli_result_error',
    message: candidates[0] || `Claude CLI ended with ${subtype}`,
    subtype,
    isError: event.is_error === true,
    apiErrorStatus: event.api_error_status ?? null,
    terminalReason: event.terminal_reason ?? null,
    errors,
  };
}

function parseArgs(sessionCtx = {}) {
  const configured = String(process.env.CLAUDE_SIDEBAR_CLAUDE_ARGS || '').trim();
  let parsedArgs;
  if (configured) {
    try {
      const parsed = JSON.parse(configured);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) parsedArgs = parsed;
    } catch {}
    if (!parsedArgs) parsedArgs = configured.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((item) => item.replace(/^"|"$/g, '')) || [];
  } else {
    parsedArgs = ['-p', '--output-format', 'stream-json', '--verbose'];
  }
  const args = stripManagedClaudeArgs(parsedArgs);
  const mcpConfig = String(process.env.CLAUDE_SIDEBAR_MCP_CONFIG || '').trim();
  if (!mcpConfig) throw new Error('CLAUDE_SIDEBAR_MCP_CONFIG is required for the Pure Map Runtime');
  args.push('--strict-mcp-config', '--mcp-config', mcpConfig);
  args.push('--allowedTools', ...PURE_MAP_CLAUDE_TOOL_NAMES);
  // Session continuity: resume the pinned CLI conversation on turn 2+ (transcript
  // with tool results carries over → no re-reading), create it on turn 1. Skip if
  // the operator already configured a session/resume flag via CLAUDE_SIDEBAR_CLAUDE_ARGS.
  if (sessionCtx.cliSessionId && !args.some((a) => ['--resume', '-r', '--continue', '-c', '--session-id'].includes(a))) {
    if (sessionCtx.resume) args.push('--resume', sessionCtx.cliSessionId);
    else args.push('--session-id', sessionCtx.cliSessionId);
  }
  // Token-level streaming: without this flag stream-json only emits whole
  // assistant messages, so the sidebar shows the answer in one burst.
  if (!args.includes('--include-partial-messages')) args.push('--include-partial-messages');
  return args;
}
function historyText(history = []) {
  if (!Array.isArray(history) || !history.length) return '';
  const lines = [];
  for (const item of history.slice(-16)) {
    const role = item?.role === 'assistant' ? 'Assistant' : item?.role === 'user' ? 'User' : 'System';
    const content = String(item?.content || '').trim();
    if (content) lines.push(`${role}: ${content}`);
  }
  return lines.length ? `\n\n<conversation_context>\n${lines.join('\n\n')}\n</conversation_context>` : '';
}
function interactionText(context) {
  const page = context?.task?.page || context?.identity || context?.page || null;
  if (!page) return '';
  const projectPages = Array.isArray(context?.projectPages || context?.workspace)
    ? (context.projectPages || context.workspace)
    : [];
  const pageLines = projectPages.slice(0, 20).map((item) =>
    `- alias=${JSON.stringify(item.alias || item.id || item.title || '')}; tabId=${item.tabId || ''}; title=${JSON.stringify(item.title || '')}; url=${item.url || ''}`
  );
  return `\n\n<browser_task_context>
Primary page for this turn:
Title: ${page.title || ''}
URL: ${page.url || ''}
Tab ID: ${page.tabId || ''}
Task ID: ${context?.task?.id || context?.taskId || ''}
Page selection source: ${context?.task?.selectionSource || context?.selectionSource || ''}
Page selection mode: ${context?.task?.pageSelectionMode || context?.mode || ''}

Project pages available without activating browser tabs:
${pageLines.length ? pageLines.join('\n') : '(none saved)'}

Rules:
1. The primary page above is authoritative for this turn. Do not replace it with the currently active browser tab. Pass Tab ID ${page.tabId || ''} explicitly to the first browser_map, browser_locate, browser_read, or browser_act call. It stays bound even when the user changes tabs.
2. When the request refers to another document, admin page, screenshot page, log page, or saved project page, pass its tabId or pageAlias directly to one of the four browser-map tools.
3. Explicit tabId/pageAlias overrides the primary page for that tool and does not activate the tab.
4. There is no tab-switching tool in the Pure Map Runtime; page selection is data, not a browser UI action.
5. A single task may read several pages in sequence. For example, read a Lark requirement first, then inspect the admin page containing its screenshot.
6. Return the requested result; do not narrate failed tab-switch attempts.
7. Use browser_map → browser_locate → browser_read for documents, Lark, Figma, spreadsheets, admin consoles, virtual lists and ordinary sites. The map layer chooses adapters internally.
8. For a page summary, read locator document:root exactly once. The runtime executes one internal sequential read plan across the saved anchors. Claim full coverage only when readCoverage="complete" and plannedSectionCount equals returnedSectionCount. If the read is partial or terminal, report the failed sections and do not issue follow-up locate/read calls.
9. For a numbered requirement, call browser_locate with that exact number and then browser_read the returned locator. The locator automatically materializes off-screen Lark virtual-scroll content; do not scroll the previous item as a substitute.
10. A page map is persistent and is never rebuilt by browser_locate, browser_read, or browser_act. Only call browser_map with refresh=true when the user explicitly says the page changed, asks to refresh/re-index, or directly reports that the saved map omitted an existing item.
11. If browser_map returns map_build_incomplete, map_build_failed, or retryRequiresExplicitRefresh=true, stop browser tool use for this turn. Do not call browser_map again and do not call browser_read/browser_locate against the missing map unless the current user explicitly requested a refresh. Report the compact failure once.
12. Canvas/Figma nodes marked opaque are not fully readable. Report adapter capability gaps instead of guessing from screenshots.
13. If a browser tool result contains pageChangeNotice, output that string verbatim as the first line of your reply (its own line) before anything else, then continue — the page changed under the tab (e.g. video autoplay) and the user must see it immediately.
</browser_task_context>`;
}
function larkIntentText(prompt, context) {
  const text = String(prompt || '');
  const page = context?.task?.page || context?.identity || context?.page || null;
  const isDocumentPage = /(?:larksuite|feishu)\.com/i.test(String(page?.url || '')) || /文档|document|wiki/i.test(String(page?.title || ''));
  const summaryIntent = /(?:总结|概括|提炼|最重要的.{0,8}(?:信息|要点)|summary|summarize)/i.test(text);
  const requirementMatch = text.match(/第\s*(\d{1,4})\s*(?:条|项|点)/);
  if (requirementMatch) {
    return `\n\n<mandatory_universal_map_route>\nCall browser_map for tabId=${page?.tabId || ''} to get or reuse the persistent page map. Then call browser_locate with query=${JSON.stringify(`第${requirementMatch[1]}条 ${text}`)} and the same tabId, followed by browser_read on the returned locator. locate/read must never refresh or rebuild the map. If the user explicitly reports that this item exists but the saved map omitted it, call browser_map once with refresh=true and retry once.\n</mandatory_universal_map_route>`;
  }
  if (summaryIntent) {
    return `\n\n<mandatory_universal_map_route>\nCall browser_map once for tabId=${page?.tabId || ''}; it creates the map only when none exists and otherwise reuses the persistent map. Then call browser_read with locator="document:root", mode="document_summary_source", taskId="page-summary", tabId=${page?.tabId || ''}, and maxChars=120000. Do not call browser_map again, do not probe for a hypothetical next numbered item, and do not cross-check through another adapter. If the read returns an explicit coverage error, report that exact limitation.\n</mandatory_universal_map_route>`;
  }
  if (isDocumentPage) {
    return `\n\n<mandatory_universal_map_route>\nCall browser_map once to get or reuse the persistent map, then browser_locate with the user's question and tabId=${page?.tabId || ''}, followed by browser_read on the best stable locator. Never refresh the map unless the user explicitly requests it.\n</mandatory_universal_map_route>`;
  }
  return `\n\n<universal_map_preference>For page understanding, call browser_map once to get or reuse the persistent page map, then use browser_locate and browser_read. Do not rebuild the map during follow-up conversation.</universal_map_preference>`;
}

function isToolInventoryQuestion(text) {
  return /(?:能使用|可用|有哪些|列出|查看).{0,12}(?:mcp|工具)|(?:mcp|工具).{0,12}(?:能使用|可用|有哪些|列表|清单)/i.test(String(text || ''));
}
// A leading-slash sidebar message is a Claude Code slash command and must reach
// the CLI VERBATIM. Appending the usual context blocks (<browser_task_context>…)
// turns them into the command's argument — observed: "/model" + appended context
// became the model name → API 400 "model: String should have at most 256
// characters". Slash commands run exactly like on the command line.
function detectSlashCommand(message = {}) {
  const text = String(message.prompt ?? message.message ?? message.text ?? message.content ?? '');
  const match = text.match(/^\s*(\/\S*)/);
  return match ? match[1] : null;
}
function extractText(event) {
  if (!event || typeof event !== 'object') return '';
  if (typeof event.result === 'string') return event.result;
  if (typeof event.text === 'string') return event.text;
  const content = event.message?.content || event.content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('');
}
function parseStreamLine(state, line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  const type = String(event?.type || '');
  if (type === 'system') {
    if (event.subtype === 'init') {
      const reportedTools = event.tools ?? event.available_tools ?? event.data?.tools ?? event.message?.tools;
      const surface = validateClaudeToolSurface(reportedTools);
      state.toolSurface = surface;
      if (!surface.ok) {
        state.toolSurfaceError = surface;
        emitStatus(state.requestId, '浏览器地图工具面不正确', 'failed', JSON.stringify(surface));
        writeNative({
          type: 'error',
          requestId: state.requestId,
          error: surface.code,
          diagnostics: surface,
        });
        state.interrupted = true;
        try { state.child.kill('SIGINT'); } catch {}
        return;
      }
      emitStatus(state.requestId, '浏览器地图工具已加载', 'running', JSON.stringify({ server: PURE_MAP_SERVER_NAME, tools: surface.expected }));
      emitCapabilities(event); // 顺带把 slash_commands/agents 喂给侧栏斜杠菜单
      if (state.inventoryIntent) {
        const inventory = formatPureMapToolInventory(surface);
        emitAssistantMessage(state.requestId, inventory);
        state.directResult = true;
        state.interrupted = true;
        try { state.child.kill('SIGINT'); } catch {}
      }
      return;
    }
    // Slash commands executed by the CLI report their output as local-command
    // stdout/stderr system events; surface them so the sidebar shows the same
    // output as the terminal.
    const localOutput = String(event.content ?? event.text ?? '');
    const stdoutMatch = localOutput.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
    const stderrMatch = localOutput.match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/);
    const surfaced = [stdoutMatch?.[1], stderrMatch?.[1]].filter((part) => part && part.trim()).join('\n').trim();
    if (surfaced) emitCommandOutput(state.requestId, surfaced, { command: state.slashCommand || null, isError: Boolean(stderrMatch?.[1] && !stdoutMatch?.[1]) });
    return;
  }
  if (type === 'stream_event') {
    // Token-level partials (--include-partial-messages). Stream each text
    // delta immediately; the later full assistant event is deduplicated below.
    const inner = event.event || {};
    if (inner.type === 'message_start') { state.partialText = ''; return; }
    const deltaText = inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string'
      ? inner.delta.text
      : '';
    if (deltaText) {
      state.partialText = `${state.partialText || ''}${deltaText}`;
      emitAssistantDelta(state.requestId, deltaText);
    }
    return;
  }
  if (type === 'assistant') {
    const text = extractText(event);
    if (text && text === state.partialText) {
      // Already streamed token by token; record it and emit nothing.
      state.lastAssistantText = text;
      state.partialText = '';
    } else if (text && text !== state.lastAssistantText) {
      const delta = text.startsWith(state.lastAssistantText) ? text.slice(state.lastAssistantText.length) : text;
      state.lastAssistantText = text;
      state.partialText = '';
      if (delta) emitAssistantDelta(state.requestId, delta);
    }
    const toolUse = Array.isArray(event.message?.content) ? event.message.content.find((part) => part?.type === 'tool_use') : null;
    if (toolUse?.name) emitStatus(state.requestId, `正在执行 ${toolUse.name}`, 'running');
    return;
  }
  if (type === 'result') {
    state.resultSeen = true;
    const subtype = String(event.subtype || '');
    const isError = event.is_error === true || subtype.startsWith('error');
    if (isError) {
      state.resultError = resultErrorDetails(event, state);
      emitStatus(state.requestId, 'Claude CLI 执行失败', 'failed', state.resultError.message);
      logHost('claude_result_error', { requestId: state.requestId, ...state.resultError });
      return;
    }
    const text = extractText(event);
    if (text && !state.lastAssistantText) { state.lastAssistantText = text; emitAssistantMessage(state.requestId, text); }
    return;
  }
  if (type.includes('tool')) {
    emitStatus(state.requestId, event.name ? `正在执行 ${event.name}` : '正在使用浏览器工具', 'running');
  }
}

function normalizedSessionId(message = {}, forceNew = false) {
  const explicit = message.sessionId || message.session_id || message.resumeSessionId || message.resume_session_id || null;
  const sessionId = String(explicit || (!forceNew && currentSessionId) || `sidebar-${Date.now().toString(36)}`);
  currentSessionId = sessionId;
  return sessionId;
}
function normalizeLegacyMessage(message = {}) {
  const incoming = message && typeof message === 'object' ? { ...message } : {};
  const type = String(incoming.type || '').toLowerCase();
  const chatAliases = new Set(['send_message', 'user_message', 'chat_message', 'prompt', 'message']);
  if (chatAliases.has(type)) incoming.type = 'chat';
  if (type === 'stop' || type === 'cancel' || type === 'interrupt_request') incoming.type = 'interrupt';
  if (!incoming.requestId && incoming.request_id) incoming.requestId = incoming.request_id;
  if (!incoming.sessionId && incoming.session_id) incoming.sessionId = incoming.session_id;
  if (!incoming.prompt) {
    const candidate = incoming.message ?? incoming.text ?? incoming.content ?? incoming.input;
    if (typeof candidate === 'string') incoming.prompt = candidate;
  }
  return incoming;
}
function legacySessionPrepared(message = {}) {
  const sessionId = normalizedSessionId(message);
  return {
    type: 'session_prepared',
    requestId: message.requestId || message.request_id || null,
    sessionId,
    session_id: sessionId,
    ready: true,
    prepared: true,
    capabilitiesStatus: 'pending',
    version: VERSION,
    runtime: 'pure-map-cli',
    mcpServer: PURE_MAP_SERVER_NAME,
    modelVisibleTools: ['browser_map', 'browser_locate', 'browser_read', 'browser_act'],
  };
}
function legacySessionsReply(message = {}) {
  const sessions = listSessionRecords().map((record) => ({
    sessionId: record.sessionId,
    session_id: record.sessionId,
    id: record.sessionId,
    title: record.title || '未命名会话',
    name: record.title || '未命名会话',
    // Field names the history UI actually reads (sidepanel.js): summary/lastModified/
    // cwd. Without these it showed every session as "未命名会话 / Invalid Date" and
    // sorted wrong. cwd reuses the pinned CLI-session cwd when present.
    summary: record.title || '未命名会话',
    lastModified: record.updatedAt || record.createdAt || null,
    cwd: record.cliCwd || record.cwd || null,
    createdAt: record.createdAt,
    created_at: record.createdAt,
    updatedAt: record.updatedAt,
    updated_at: record.updatedAt,
    messageCount: record.messages?.length || 0,
  }));
  return {
    type: 'sessions',
    requestId: message.requestId || message.request_id || null,
    sessions,
    result: sessions,
    version: VERSION,
    runtime: 'pure-map-cli',
  };
}
function legacySessionMessagesReply(message = {}) {
  const sessionId = normalizedSessionId(message);
  const record = readSessionRecord(sessionId);
  const messages = (record?.messages || []).map((item, index) => ({
    id: `${sessionId}-${index}`,
    role: item.role,
    type: item.role,
    content: item.content,
    text: item.content,
    at: item.at,
    timestamp: item.at,
  }));
  return {
    type: 'session_messages',
    requestId: message.requestId || message.request_id || null,
    sessionId,
    session_id: sessionId,
    messages,
    result: messages,
    version: VERSION,
  };
}
function buildPrompt(message, opts = {}) {
  const copy = contextAuthority.apply(message);
  const prepared = prepareChatMessageAttachments(copy, { sessionId: copy.sessionId });
  let prompt = String(prepared.message.prompt || prepared.message.message || prepared.message.text || prepared.message.content || '').trim();
  const slashCommand = detectSlashCommand(prepared.message);
  if (slashCommand) {
    // Verbatim passthrough: no history, page context, routing hints or runtime
    // banner — the CLI executes the command exactly like on the command line.
    logHost('chat_slash_command_passthrough', { command: slashCommand.slice(0, 64) });
    return { prompt, attachments: prepared.files, slashCommand };
  }
  // On a resumed CLI session the real transcript (with tool results) is already in
  // context, so replaying text history would be redundant and misleading; only
  // inject it on a fresh (non-resumed) session.
  prompt += opts.resume ? '' : historyText(prepared.message.history);
  prompt += interactionText(prepared.message.interactionContext);
  prompt += larkIntentText(prompt, prepared.message.interactionContext);
  prompt += `\n\n<sidebar_runtime>\nClaude Sidebar version ${VERSION}. This is the Pure Map Runtime. The only browser MCP server is claude-sidebar-pure-map. Exactly four browser tools are model-visible: browser_map, browser_locate, browser_read and browser_act. They expose one stable protocol across Lark documents, ordinary DOM, virtual grids, Figma/canvas surfaces and admin consoles through capability-declared adapters. Capability levels differ by page; never claim structured access when an adapter reports visual_only or unsupported. No Lark-specific, app-specific, page-context, screenshot, navigation or compatibility browser tools are available. Use explicit tabId/pageAlias on the four tools for cross-page work. Preserve map completeness and source evidence. Never infer opaque canvas content, unseen virtual content or failed adapter output. browser_act requires confirmation for click/input/select/submit. Answer with concrete results rather than narrating failed attempts. Preserve exact structured runtime error codes and actual version fields.\n</sidebar_runtime>`;
  prompt += `\n\n<response_language>Respond in the same language as the user's latest message above. If it is ambiguous or mixed, default to 简体中文. Do not switch to the page's language. Structured runtime error codes and the ⚠️ page-change notice stay verbatim.</response_language>`;
  return { prompt, attachments: prepared.files };
}
function finalizeChat(state, emitTerminal) {
  if (!state || state.finalized) return false;
  state.finalized = true;
  active.delete(state.requestId);
  try { emitTerminal?.(); } catch (error) {
    writeNative({ type: 'error', requestId: state.requestId, error: String(error?.message || error) });
  }
  if (runningRequestId === state.requestId) runningRequestId = null;
  logHost('chat_finished', { requestId: state.requestId, queued: pendingChats.length });
  queueMicrotask(startNextChat);
  return true;
}
function startChat(message, enqueuedAt = Date.now()) {
  const requestId = String(message.requestId || `chat-${Date.now()}`);
  if (active.has(requestId)) throw new Error(`request already active: ${requestId}`);
  const sessionId = normalizedSessionId(message);
  message.sessionId = sessionId;
  if (usesLegacyProtocol()) writeNative({ type: 'session', sessionId, cwd: message.cwd || null });
  emitTurnStarted(requestId, Math.max(0, Date.now() - enqueuedAt));
  appendSessionMessage(sessionId, 'user', String(message.prompt || message.message || message.text || message.content || ''));
  const cwdSelection = resolveChatCwd(message);
  const cli = cliSessionFor(sessionId, cwdSelection.cwd);
  // Resume must run in the same project the session was created in, else the CLI
  // cannot re-open the transcript — reuse the pinned cwd once a session exists.
  const effectiveCwd = cli.resume && cli.cliCwd ? cli.cliCwd : cwdSelection.cwd;
  const { prompt, attachments, slashCommand } = buildPrompt(message, { resume: cli.resume });
  const command = process.env.CLAUDE_SIDEBAR_CLAUDE_BIN || 'claude';
  const args = parseArgs(cli);
  const mcpConfig = String(process.env.CLAUDE_SIDEBAR_MCP_CONFIG || '').trim();
  const preflight = runtimePreflight({ command, mcpConfig, cwd: effectiveCwd });
  if (cwdSelection.requestedMissing) {
    emitStatus(requestId, '会话工作目录不存在，已使用安全目录', 'running', `${cwdSelection.requested} -> ${cwdSelection.cwd}`);
  }
  emitStatus(requestId, attachments.length ? `正在读取 ${attachments.length} 个附件` : '正在思考', 'running');
  const child = spawn(preflight.resolvedCommand, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: effectiveCwd,
    env: { ...process.env, PWD: effectiveCwd },
    shell: false,
  });
  const state = {
    requestId,
    sessionId,
    cli,
    child,
    slashCommand: slashCommand || null,
    buffer: '',
    stderr: '',
    lastAssistantText: '',
    resultSeen: false,
    resultError: null,
    interrupted: false,
    directResult: false,
    inventoryIntent: isToolInventoryQuestion(message.prompt),
    toolSurface: null,
    toolSurfaceError: null,
    finalized: false,
  };
  active.set(requestId, state);
  // Claim the pinned CLI session id as soon as the process launches, so EVERY later
  // turn uses --resume (well-defined) rather than re-passing --session-id. Covers the
  // interrupted-turn-1 case: even a stopped first turn that already created the CLI
  // session is resumed next time (a resume that finds nothing self-heals to fresh).
  if (!cli.resume) markCliSessionStarted(sessionId);
  logHost('chat_started', { requestId, sessionId, cwd: cwdSelection.cwd, requestedCwd: cwdSelection.requested || null, protocolMode: protocolMode === 'auto' ? 'modern' : protocolMode, queuedForMs: Math.max(0, Date.now() - enqueuedAt) });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    state.buffer += chunk;
    let index;
    while ((index = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, index).trim();
      state.buffer = state.buffer.slice(index + 1);
      if (line) parseStreamLine(state, line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { state.stderr = `${state.stderr}${chunk}`.slice(-12000); });
  child.on('error', (error) => {
    finalizeChat(state, () => writeNative({ type: 'error', requestId, error: `无法启动 Claude CLI：${error.message}` }));
  });
  child.on('close', (code, signal) => {
    if (state.finalized) return;
    if (!state.interrupted && state.buffer.trim()) parseStreamLine(state, state.buffer.trim());
    if (state.interrupted) {
      if (state.directResult) finalizeChat(state, () => emitDone(state));
      else if (state.toolSurfaceError) finalizeChat(state);
      else finalizeChat(state, () => writeNative({ type: 'interrupted', requestId, signal: signal || null }));
      return;
    }
    // A resume that failed because the pinned transcript is gone/invalid → drop the
    // pin so the NEXT turn recreates a fresh CLI session (self-heal, no respawn now).
    const staleResume = state.cli?.resume
      && /session|resume|conversation|not found|no such|does not exist/i.test(`${state.stderr || ''} ${state.resultError?.message || ''}`);
    if (state.resultError) {
      if (staleResume) resetCliSession(state.sessionId);
      finalizeChat(state, () => writeNative({
        type: 'error',
        requestId,
        error: state.resultError.message,
        code: state.resultError.code,
        diagnostics: state.resultError,
      }));
    } else if (code === 0) {
      appendSessionMessage(state.sessionId, 'assistant', state.lastAssistantText);
      finalizeChat(state, () => emitDone(state));
    } else {
      if (staleResume) resetCliSession(state.sessionId);
      finalizeChat(state, () => writeNative({ type: 'error', requestId, error: state.stderr.trim() || `Claude CLI exited with code ${code}`, code: 'claude_cli_exit_error', exitCode: code, signal: signal || null }));
    }
  });
  child.stdin.end(prompt);
  return { requestId, attachments };
}
function startNextChat() {
  if (runningRequestId || !pendingChats.length) return;
  const item = pendingChats.shift();
  runningRequestId = item.requestId;
  try {
    startChat(item.message, item.enqueuedAt);
  } catch (error) {
    runningRequestId = null;
    writeNative({
      type: 'error',
      requestId: item.requestId,
      error: String(error?.message || error),
      code: error?.code || 'chat_start_failed',
      diagnostics: error?.diagnostics || null,
    });
    queueMicrotask(startNextChat);
  }
}
function enqueueChat(message) {
  const requestId = String(message.requestId || `chat-${Date.now()}`);
  if (active.has(requestId) || pendingChats.some((item) => item.requestId === requestId)) {
    throw new Error(`request already active or queued: ${requestId}`);
  }
  const item = { requestId, message: { ...message, requestId }, enqueuedAt: Date.now() };
  if (runningRequestId) {
    pendingChats.push(item);
    emitQueued(requestId, pendingChats.length);
    logHost('chat_queued', { requestId, position: pendingChats.length });
  } else {
    pendingChats.push(item);
    startNextChat();
  }
  return { requestId, attachmentCount: Array.isArray(message.attachments) ? message.attachments.length : 0 };
}
function interrupt(message) {
  const requestId = String(message.requestId || '');
  let interrupted = 0;
  const candidates = requestId ? [active.get(requestId)].filter(Boolean) : [...active.values()];
  for (const state of candidates) {
    state.interrupted = true;
    interrupted += 1;
    try { state.child.kill('SIGINT'); } catch {}
    setTimeout(() => { if (state.child.exitCode === null) try { state.child.kill('SIGKILL'); } catch {} }, 1200).unref?.();
  }
  for (let index = pendingChats.length - 1; index >= 0; index -= 1) {
    const item = pendingChats[index];
    if (requestId && item.requestId !== requestId) continue;
    pendingChats.splice(index, 1);
    interrupted += 1;
    writeNative({ type: 'interrupted', requestId: item.requestId, queued: true });
  }
  return interrupted;
}
export async function handleIncomingMessage(rawMessage) {
  detectProtocolMode(rawMessage);
  const message = normalizeLegacyMessage(rawMessage);
  switch (String(message?.type || '')) {
    case 'hello':
      cleanupOldAttachments();
      return { type: 'hello_ack', ready: true, version: VERSION, runtime: 'pure-map-cli', mcpServer: PURE_MAP_SERVER_NAME, modelVisibleTools: ['browser_map', 'browser_locate', 'browser_read', 'browser_act'], limits: chatAttachmentLimits };
    case 'new_session':
      cleanupOldAttachments();
      currentSessionId = null;
      probeCapabilities(); // 异步拉命令列表,连上就能打 / 看到全部命令
      return legacySessionPrepared({ ...message, sessionId: normalizedSessionId({}, true) });
    case 'prepare_session':
    case 'select_session':
    case 'resume_session':
      cleanupOldAttachments();
      probeCapabilities(); // 异步拉命令列表,连上就能打 / 看到全部命令
      return legacySessionPrepared(message);
    case 'list_sessions':
      return legacySessionsReply(message);
    case 'get_session_messages':
      return legacySessionMessagesReply(message);
    case 'permission_response':
    case 'answer_question':
      return { type: 'ack', requestId: message.requestId || null, accepted: true, version: VERSION };
    case 'context_sync': {
      const selection = contextAuthority.update(message);
      return {
        type: 'context_sync_ack',
        version: VERSION,
        mode: selection.mode,
        pinnedTabId: selection.pinnedPage?.tabId || null,
        nextTabId: selection.nextPage?.tabId || null,
        syncedAt: selection.syncedAt,
      };
    }
    case 'context_status':
      return { type: 'context_status', version: VERSION, selection: contextAuthority.snapshot() };
    case 'chat': {
      // QA 拦截:①人审待确认时,这条消息作为 y/n 回答;②/qa 命令 → 跑编排器,不转 Claude CLI。
      const chatText = String(message.prompt ?? message.message ?? message.text ?? message.content ?? '');
      if (qaSidebar.hasPending()) {
        qaSidebar.answer(chatText);
        return { type: 'accepted', requestId: String(message.requestId || `qa-${Date.now()}`) };
      }
      if (figmaSidebar.hasPending()) { // /figma 等"前端仓库路径"回复
        figmaSidebar.answer(chatText);
        return { type: 'accepted', requestId: String(message.requestId || `figma-${Date.now()}`) };
      }
      if (figmaWsSidebar.hasPending()) { // /figma-ws 等"前端仓库路径"回复
        figmaWsSidebar.answer(chatText);
        return { type: 'accepted', requestId: String(message.requestId || `figma-ws-${Date.now()}`) };
      }
      // 当前页 pageContext(/qa 与 /figma 共用):chat 消息带 pageContext;回退到 host 侧上下文权威。
      const snap = contextAuthority.snapshot();
      const pc = (message.pageContext && Number(message.pageContext.tabId) ? message.pageContext : null)
        || snap?.pinnedPage || snap?.currentPage || null;
      const pageContext = pc && Number(pc.tabId)
        ? { tabId: Number(pc.tabId), url: String(pc.url || ''), title: String(pc.title || '') }
        : null;
      if (qaSidebar.isQaCommand(chatText)) {
        const requestId = String(message.requestId || `qa-${Date.now()}`);
        const emit = {
          status: (label) => emitStatus(requestId, label),
          message: (text) => emitAssistantMessage(requestId, text),
          done: () => emitDone({ requestId }),
        };
        qaSidebar.runQaInSidebar(chatText, emit, pageContext); // 异步跑,进度经 emit 回显
        return { type: 'accepted', requestId };
      }
      if (figmaSidebar.isFigmaCommand(chatText)) {
        const requestId = String(message.requestId || `figma-${Date.now()}`);
        const emit = {
          status: (label) => emitStatus(requestId, label),
          message: (text) => emitAssistantMessage(requestId, text),
          done: () => emitDone({ requestId }),
        };
        // 加载模式:读设计 → 注入当前会话(用侧栏 cwd;非前端仓库会先问用户)。之后续聊即在该仓库开发。
        figmaSidebar.runFigmaInSidebar(chatText, emit, pageContext, {
          cwd: String(message.cwd || ''),
          inject: (repo, prompt) => {
            try { enqueueChat({ type: 'chat', prompt, cwd: repo, sessionId: message.sessionId }); }
            catch (e) { emitAssistantMessage(requestId, `注入开发会话失败:${e?.message || e}`); }
          },
        });
        return { type: 'accepted', requestId };
      }
      if (figmaWsSidebar.isFigmaWsCommand(chatText)) {
        const requestId = String(message.requestId || `figma-ws-${Date.now()}`);
        const emit = {
          status: (label) => emitStatus(requestId, label),
          message: (text) => emitAssistantMessage(requestId, text),
          done: () => emitDone({ requestId }),
        };
        // 独立 WS 管道:全自动抓帧 → 解码抽子树 → 注入会话(cwd 用侧栏;非前端仓库先问)。
        figmaWsSidebar.runFigmaWsInSidebar(chatText, emit, pageContext, {
          cwd: String(message.cwd || ''),
          inject: (repo, prompt) => {
            try { enqueueChat({ type: 'chat', prompt, cwd: repo, sessionId: message.sessionId }); }
            catch (e) { emitAssistantMessage(requestId, `注入开发会话失败:${e?.message || e}`); }
          },
        });
        return { type: 'accepted', requestId };
      }
      const { requestId, attachmentCount } = enqueueChat(message);
      return { type: 'accepted', requestId, attachmentCount, authoritativePage: contextAuthority.snapshot()?.pinnedPage || contextAuthority.snapshot()?.nextPage || null };
    }
    case 'interrupt':
      return { type: 'interrupt_ack', requestId: message.requestId || null, interrupted: interrupt(message) };
    case 'ping':
      return { type: 'pong', version: VERSION };
    default:
      return { type: 'error', requestId: message?.requestId || null, error: `Unsupported chat host message: ${message?.type}` };
  }
}
function processInput(chunk) {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  while (stdinBuffer.length >= 4) {
    const length = stdinBuffer.readUInt32LE(0);
    if (length > 64 * 1024 * 1024) { writeNative({ type: 'error', error: 'Native message exceeds 64 MB' }); process.exit(1); }
    if (stdinBuffer.length < 4 + length) return;
    const payload = stdinBuffer.subarray(4, 4 + length);
    stdinBuffer = stdinBuffer.subarray(4 + length);
    let message;
    try { message = JSON.parse(payload.toString('utf8')); }
    catch (error) { writeNative({ type: 'error', error: `Invalid JSON: ${error.message}` }); continue; }
    Promise.resolve(handleIncomingMessage(message)).then((reply) => {
      if (Array.isArray(reply)) {
        for (const item of reply) if (item) writeNative(item);
      } else if (reply) {
        writeNative(reply);
      }
    }).catch((error) => {
      writeNative({ type: 'error', requestId: message?.requestId || message?.request_id || null, error: error.message });
    });
  }
}
function shutdown() {
  for (const state of active.values()) try { state.child.kill('SIGTERM'); } catch {}
  process.exit(0);
}
writeNative({
  type: 'hello',
  hostVersion: VERSION,
  version: VERSION,
  protocolVersion: 13,
  transportMode: 'direct-pure-map',
  runtimeMode: 'external-cli',
  imageMode: 'universal-browser-map',
  ready: true,
  mcpServer: PURE_MAP_SERVER_NAME,
  modelVisibleTools: ['browser_map', 'browser_locate', 'browser_read', 'browser_act'],
});

process.stdin.on('data', processInput);
process.stdin.on('end', shutdown);
process.stdin.on('error', shutdown);
for (const signal of ['SIGTERM','SIGINT','SIGHUP']) process.on(signal, shutdown);
