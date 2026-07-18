#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import * as __claudeSidebarAttachmentFs from "node:fs";
import * as __claudeSidebarAttachmentPath from "node:path";
import * as __claudeSidebarAttachmentOs from "node:os";
import * as __claudeSidebarAttachmentCrypto from "node:crypto";

import * as __claudeSidebarCancellationChildProcess from "node:child_process";

// CLAUDE_SIDEBAR_V6121_CHAT_CANCELLATION_RUNTIME
const __claudeSidebarCancellationRuntime = (() => {
const CANCEL_TYPES = new Set([
  'cancel', 'stop', 'abort', 'interrupt', 'cancel_chat', 'stop_chat',
  'cancel_message', 'stop_generation', 'cancel_generation', 'interrupt_generation'
]);
const CHAT_TYPES = new Set([
  'chat', 'send_chat', 'send_message', 'sendmessage', 'user_message', 'usermessage',
  'prompt', 'submit_prompt', 'submitprompt'
]);

let activeTurnId = null;
let activeSessionId = null;
let lastCancellation = null;
let forceKillTimer = null;

function normalizeType(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function messageTypes(message) {
  return [message?.type, message?.action, message?.kind, message?.event, message?.command, message?.messageType]
    .map(normalizeType)
    .filter(Boolean);
}

function isCancellationMessage(message) {
  return messageTypes(message).some((type) => CANCEL_TYPES.has(type)) || message?.forceAbort === true;
}

function isChatMessage(message) {
  if (messageTypes(message).some((type) => CHAT_TYPES.has(type))) return true;
  const hasPrompt = ['prompt', 'text', 'content', 'message'].some((key) => typeof message?.[key] === 'string');
  const hasIdentity = ['sessionId', 'conversationId', 'chatId', 'threadId'].some((key) => message?.[key] != null);
  return hasPrompt && hasIdentity;
}

function readProcessTable() {
  try {
    const result = __claudeSidebarCancellationChildProcess.spawnSync('/bin/ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) return [];
    return String(result.stdout).split(/\r?\n/).map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]) } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function descendantPids(rootPid = process.pid) {
  const rows = readProcessTable();
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const discovered = [];
  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length) {
    const parent = queue.shift();
    for (const pid of children.get(parent) || []) {
      if (seen.has(pid) || pid === process.pid) continue;
      seen.add(pid);
      discovered.push(pid);
      queue.push(pid);
    }
  }
  return discovered.reverse();
}

function signalPids(pids, signal) {
  const signalled = [];
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      signalled.push(pid);
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        try { process.stderr.write(`[Claude Sidebar] unable to ${signal} pid ${pid}: ${error?.message || error}\n`); } catch {}
      }
    }
  }
  return signalled;
}

function cancelActiveTurn(message = {}) {
  const targetTurnId = String(message.targetTurnId || message.claudeSidebarTurnId || activeTurnId || '');
  const requestedAt = new Date().toISOString();
  const descendants = descendantPids(process.pid);
  const terminated = signalPids(descendants, 'SIGTERM');
  clearTimeout(forceKillTimer);
  forceKillTimer = setTimeout(() => {
    const remaining = descendantPids(process.pid);
    signalPids(remaining, 'SIGKILL');
  }, 1200);
  forceKillTimer.unref?.();
  lastCancellation = {
    targetTurnId: targetTurnId || null,
    sessionId: activeSessionId,
    reason: message.reason || 'user_stop',
    requestedAt,
    terminatedPids: terminated,
  };
  activeTurnId = null;
  return {
    ok: true,
    cancelled: true,
    code: 'turn_cancelled',
    ...lastCancellation,
  };
}

function handleIncomingMessage(message) {
  if (!message || typeof message !== 'object') return { handled: false };
  if (isCancellationMessage(message)) {
    return { handled: true, response: cancelActiveTurn(message) };
  }
  if (isChatMessage(message)) {
    activeTurnId = String(message.claudeSidebarTurnId || message.turnId || message.requestId || `turn-${Date.now()}`);
    activeSessionId = String(message.sessionId || message.conversationId || message.chatId || message.threadId || '') || null;
    message.claudeSidebarTurnId = activeTurnId;
  }
  return { handled: false };
}

function status() {
  return {
    activeTurnId,
    activeSessionId,
    lastCancellation,
    descendantPids: descendantPids(process.pid),
  };
}

  return { handleIncomingMessage, cancelActiveTurn, status, isCancellationMessage, isChatMessage };
})();

// CLAUDE_SIDEBAR_V611_CHAT_ATTACHMENT_RUNTIME
const __claudeSidebarAttachmentStore = (() => {
  const fs = __claudeSidebarAttachmentFs;
  const path = __claudeSidebarAttachmentPath;
  const os = __claudeSidebarAttachmentOs;
  const crypto = __claudeSidebarAttachmentCrypto;




const MAX_FILES = 4;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ROOT = process.env.CLAUDE_SIDEBAR_ATTACHMENT_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeSidebarHost', 'attachments');

function sanitizeName(input) {
  const original = String(input || 'attachment').normalize('NFKC');
  const base = path.basename(original).replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/:*?"<>|]/g, '_').trim();
  const safe = (base || 'attachment').slice(0, 180);
  return safe === '.' || safe === '..' ? 'attachment' : safe;
}

function safeSegment(input) {
  return String(input || 'session')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'session';
}

function ensureInside(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('attachment path escaped storage root');
}

function decodeBase64(value) {
  const data = String(value || '');
  if (!data || data.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 16) throw new Error('invalid or oversized attachment payload');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('attachment payload is not valid base64');
  return Buffer.from(data, 'base64');
}

function findPromptTarget(message) {
  for (const key of ['prompt', 'text', 'content', 'message']) {
    if (typeof message?.[key] === 'string') return { target: message, key };
  }
  for (const containerKey of ['message', 'payload', 'input', 'data']) {
    const nested = message?.[containerKey];
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
    for (const key of ['prompt', 'text', 'content']) {
      if (typeof nested[key] === 'string') return { target: nested, key };
    }
  }
  return null;
}

function buildContext(files) {
  const lines = files.map((file, index) =>
    `${index + 1}. ${file.name} (${file.mimeType}, ${file.size} bytes)\n   Local path: ${file.path}`
  );
  return `\n\n<claude_sidebar_attachments>\nThe user attached the following local files to this turn:\n${lines.join('\n')}\n\nTreat these files as part of the user's message. Before answering, inspect every relevant file with the available local file-reading tools. For images, inspect the actual image pixels; do not infer content from the filename. For PDFs, documents, spreadsheets, archives, or source files, use the appropriate reader/tool. Do not claim a file was read unless the tool call succeeded.\n</claude_sidebar_attachments>`;
}

function cleanupOldAttachments({ now = Date.now(), retentionMs = RETENTION_MS } = {}) {
  let removed = 0;
  try {
    if (!fs.existsSync(ROOT)) return { ok: true, removed };
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const target = path.join(ROOT, entry.name);
      let stat;
      try { stat = fs.statSync(target); } catch { continue; }
      if (now - stat.mtimeMs < retentionMs) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed += 1;
    }
  } catch (error) {
    return { ok: false, removed, error: error.message };
  }
  return { ok: true, removed };
}

function prepareChatMessageAttachments(message, options = {}) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (!attachments.length) return { ok: true, files: [], message };
  if (attachments.length > MAX_FILES) throw new Error(`too many attachments: maximum is ${MAX_FILES}`);

  let declaredTotal = 0;
  for (const attachment of attachments) {
    const size = Number(attachment?.size || 0);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
      throw new Error(`attachment ${sanitizeName(attachment?.name)} exceeds the 10 MB limit or has an invalid size`);
    }
    declaredTotal += size;
  }
  if (declaredTotal > MAX_TOTAL_BYTES) throw new Error('attachment total exceeds the 24 MB limit');

  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const session = safeSegment(options.sessionId || message.sessionId || message.session_id || message.requestedSessionId || 'session');
  const turnDir = path.join(ROOT, `${session}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`);
  ensureInside(ROOT, turnDir);
  fs.mkdirSync(turnDir, { recursive: true, mode: 0o700 });

  const files = [];
  try {
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index] || {};
      const buffer = decodeBase64(attachment.data);
      const declaredSize = Number(attachment.size || 0);
      if (buffer.length !== declaredSize) {
        throw new Error(`attachment size mismatch for ${sanitizeName(attachment.name)}: declared ${declaredSize}, decoded ${buffer.length}`);
      }
      const safeName = sanitizeName(attachment.name);
      const prefix = String(index + 1).padStart(2, '0');
      const finalPath = path.join(turnDir, `${prefix}-${safeName}`);
      const tempPath = `${finalPath}.part`;
      ensureInside(ROOT, finalPath);
      fs.writeFileSync(tempPath, buffer, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tempPath, finalPath);
      files.push({
        id: String(attachment.id || ''),
        name: safeName,
        mimeType: String(attachment.mimeType || 'application/octet-stream').slice(0, 200),
        size: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        path: finalPath,
      });
    }

    const context = buildContext(files);
    const promptTarget = findPromptTarget(message);
    if (promptTarget) promptTarget.target[promptTarget.key] = `${promptTarget.target[promptTarget.key]}${context}`;
    else message.prompt = context.trimStart();
    message.attachmentRefs = files;
    delete message.attachments;
    cleanupOldAttachments();
    return { ok: true, files, message };
  } catch (error) {
    try { fs.rmSync(turnDir, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

const chatAttachmentLimits = Object.freeze({
  maxFiles: MAX_FILES,
  maxFileBytes: MAX_FILE_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  retentionMs: RETENTION_MS,
  root: ROOT,
});

  return { prepareChatMessageAttachments, cleanupOldAttachments, chatAttachmentLimits };
})();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.join(__dirname, "mcp-server.js");
const DEFAULT_CWD = process.env.CLAUDE_SIDEBAR_CWD || os.homedir();
const HISTORY_LIMIT = 80;
const HISTORY_MESSAGE_LIMIT = 60;
const HISTORY_TEXT_LIMIT = 16_000;
const DELTA_FLUSH_MS = 32;
const DELTA_FLUSH_BYTES = 2048;
const ACTIVITY_MIN_INTERVAL_MS = 120;
const BROWSER_IMAGE_MODE = process.env.CLAUDE_SIDEBAR_IMAGE_MODE || "mcp-image";
const BROWSER_CONTEXT_FILE = process.env.CLAUDE_SIDEBAR_CONTEXT_FILE || (process.platform === "darwin"
  ? path.join(os.homedir(), "Library", "Application Support", "ClaudeSidebarHost", "browser-context.json")
  : path.join(os.homedir(), ".config", "claude-sidebar", "browser-context.json"));
const DAEMON_MODE = process.argv.includes("--daemon");
const DAEMON_SOCKET_PATH = process.env.CLAUDE_SIDEBAR_DAEMON_SOCKET || path.join(
  os.tmpdir(),
  `claude-sidebar-daemon-${typeof process.getuid === "function" ? process.getuid() : "user"}.sock`,
);
let activeRelaySocket = null;
let daemonServer = null;

const SAFE_TOOLS = new Set([
  "Read", "Glob", "Grep",
  "mcp__open-claude-in-chrome__tabs_context_mcp",
  "mcp__open-claude-in-chrome__read_page",
  "mcp__open-claude-in-chrome__inspect_layout",
  "mcp__open-claude-in-chrome__get_page_text",
  "mcp__open-claude-in-chrome__find",
  "mcp__open-claude-in-chrome__read_console_messages",
  "mcp__open-claude-in-chrome__read_network_requests",
  "mcp__open-claude-in-chrome__lark_read",
  "mcp__open-claude-in-chrome__lark_search",
]);

const AUTO_APPROVED_TOOLS = new Set([...SAFE_TOOLS, "Agent", "Task"]);

const SIDEBAR_SYSTEM_PROMPT = `你运行在 Chromium 浏览器侧栏中，并连接到用户本地的 Claude Code。
默认使用中文回答，除非用户明确要求其他语言。
用户可能在浏览器中采用一个“当前页面”。当 UserPromptSubmit 上下文包含 sidebar_current_page 时，该 tabId 就是用户此刻正在页面旁讨论的精确标签页。
用户提到“当前页面”“这个网页”“这里”“屏幕上”等语义时，优先使用 open-claude-in-chrome MCP 工具实际读取该标签页，再进行判断。
必须先使用 tabs_context_mcp 确认可访问标签页。除非用户明确要求，否则不要为当前页面问题新建无关标签页。
当前浏览器图片传输模式是 ${BROWSER_IMAGE_MODE}。默认 mcp-image 模式下，computer screenshot / zoom / scroll 返回的原始 MCP image block 会直接交给 Claude；应直接查看截图判断颜色、图片内容、阴影、视觉层级、裁切和最终像素观感。不要把截图先总结成另一份视觉文字再交给主会话。
inspect_layout 是独立的按需精确测量工具，不应在每次 screenshot 后自动调用。只有问题涉及弹窗切顶/溢出、footer 或 primary action 是否在 viewport 外、按钮可达性、fixed/sticky 遮挡、内部滚动、scroll trap、响应式尺寸或修复前后布局验证时，才自动使用 inspect_layout。先用 detail=summary；仅当 compact diagnosis 不足时再用 detail=full。用户提到具体按钮/链接/控件文字时，可传 targetText 精确检查。
证据规则：截图是最终像素、颜色、图像、阴影、视觉层级和视觉裁切的事实来源；inspect_layout 是 CSS 像素几何、bounding rect、scroll chain、hit testing、pointer occlusion 和 overflow 数值的事实来源；read_page 是语义角色、accessible name 和交互结构的事实来源。不要把冲突结果“平均”或含糊综合，必须针对被判断的属性使用对应证据源，必要时再做一次定向检查。
当模式为 safe-text 时，图片块才会被故障排查层拦截并附带 accessibility/layout fallback；这是 troubleshooting 模式，不是默认产品模式。不要因为没有 image block 而循环截图。
Lark/Feishu 文档规则：lark_read/lark_search/lark_patch 始终登记在 MCP 工具目录中并由 Tool Search 按需发现。当前 adopted page 是 Lark/Feishu 文档时必须优先使用这三个文档工具，不要先用 screenshot + click + type 模拟人工编辑。默认 backend=auto：当前打开的 Lark/Feishu 文档优先使用已登录页面的 Browser Session Backend；显式 documentId 或 backend=openapi 才强制 OpenAPI。Cookie/Session 不导出 Chrome。不要因为缺少 App ID/App Secret 或本地存在失效 OpenAPI 配置就拒绝当前文档任务。简单唯一文本修改优先直接调用一次 lark_patch：replace_text/delete_text/format_text 可在 search 唯一时省略 blockId；insert_text 可用 anchorText + position 省略 blockId。只有目标存在歧义时才先 lark_search。Browser Session 使用 visible_text 坐标，零宽字符、NBSP/换行映射、session block 重定位、read-back verify 和一次有界 stale-block recovery 都由 Adapter 内部处理；不要在 content_conflict 后自行去掉安全守卫重试。成功 patch 若返回 verificationComplete=true 且 callerRereadRequired=false，不要再独立 lark_read 重读。章节/Block 结构使用 lark_read(scope=outline|tree|children)。Browser Session 返回 session:* blockId；它支持精确文本修改、replace_all、基础富文本 best-effort，以及标题、列表、代码块、引用、Todo、公式、Callout、分割线、表格和本地图片/文件的 editor-command 插入。Browser Session 对已有复杂表格行列/合并、delete_blocks、replace_image/replace_file 会在写入前返回 session_preflight_unsupported；这时说明该能力需要 OpenAPI Backend，不要静默退回坐标点击。OpenAPI Backend 继续支持完整 Block、表格与媒体结构化 API。旧版 Base、Sheet、Whiteboard 与明确不支持的控件继续走对应 Adapter 或浏览器模式。
侧栏回复应直接、清晰；需要检查页面、本地项目或执行工具时，应真正使用工具完成任务。`;

let inputBuffer = Buffer.alloc(0);
let currentRuntime = null;
let currentSessionId = null;
const permissionWaiters = new Map();
let agentSdk = null;
let agentSdkLoadPromise = null;

function errorText(error) {
  return error?.stack || error?.message || String(error);
}

function persistBrowserContext(context) {
  try {
    fs.mkdirSync(path.dirname(BROWSER_CONTEXT_FILE), { recursive: true });
    const payload = {
      ...(context && typeof context === "object" ? context : {}),
      updatedAt: Date.now(),
    };
    const tempPath = `${BROWSER_CONTEXT_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tempPath, BROWSER_CONTEXT_FILE);
    try { fs.chmodSync(BROWSER_CONTEXT_FILE, 0o600); } catch {}
  } catch (error) {
    process.stderr.write(`Unable to persist browser context: ${errorText(error)}\n`);
  }
}

async function loadAgentSdk() {
  if (agentSdk) return agentSdk;
  if (!agentSdkLoadPromise) {
    writeMessage({
      type: "boot_state",
      stage: "loading_sdk",
      text: "本地桥接已连接 · 正在加载 Claude Agent SDK…",
    });
    agentSdkLoadPromise = import("@anthropic-ai/claude-agent-sdk")
      .then((sdk) => {
        agentSdk = sdk;
        writeMessage({
          type: "boot_state",
          stage: "sdk_loaded",
          text: "Claude Agent SDK 已加载 · 正在初始化 Claude Code…",
        });
        return sdk;
      })
      .catch((error) => {
        agentSdkLoadPromise = null;
        writeMessage({
          type: "boot_error",
          stage: "loading_sdk",
          error: `Claude Agent SDK 加载失败：${errorText(error)}`,
        });
        throw error;
      });
  }
  return agentSdkLoadPromise;
}

class AsyncMessageQueue {
  constructor() {
    this.values = [];
    this.waiters = [];
    this.closed = false;
    this.failure = null;
  }

  push(value) {
    if (this.closed) throw new Error("Message queue is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  next() {
    if (this.values.length > 0) {
      return Promise.resolve({ value: this.values.shift(), done: false });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  return() {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  throw(error) {
    this.fail(error);
    return Promise.reject(error);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error) {
    if (this.closed) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.failure);
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

function findClaudeExecutable() {
  if (process.env.CLAUDE_CODE_PATH && fs.existsSync(process.env.CLAUDE_CODE_PATH)) {
    return process.env.CLAUDE_CODE_PATH;
  }
  try {
    const command = process.platform === "win32" ? "where" : "which";
    const found = execFileSync(command, ["claude"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return found || undefined;
  } catch {
    return undefined;
  }
}

const EXTERNAL_CLAUDE_PATH = findClaudeExecutable();
const CLAUDE_RUNTIME_MODE = process.env.CLAUDE_SIDEBAR_RUNTIME === "external-cli"
  ? "external-cli"
  : "sdk-builtin";

function claudeExecutableOptions() {
  if (CLAUDE_RUNTIME_MODE !== "external-cli") return {};
  if (!EXTERNAL_CLAUDE_PATH) {
    throw new Error("External CLI mode 已启用，但未找到 claude 可执行文件。重新运行 install-sidebar-host.sh，或改回 sdk-builtin 模式。");
  }
  return { pathToClaudeCodeExecutable: EXTERNAL_CLAUDE_PATH };
}

function writeNativeMessage(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

function writeMessage(message) {
  if (!DAEMON_MODE) {
    writeNativeMessage(message);
    return;
  }

  if (!activeRelaySocket || activeRelaySocket.destroyed) return;
  try {
    activeRelaySocket.write(`${JSON.stringify(message)}\n`);
  } catch (error) {
    process.stderr.write(`daemon relay write failed: ${errorText(error)}\n`);
  }
}

function parseMessages() {
  while (inputBuffer.length >= 4) {
    const length = inputBuffer.readUInt32LE(0);
    if (inputBuffer.length < 4 + length) return;
    const payload = inputBuffer.subarray(4, 4 + length).toString("utf8");
    inputBuffer = inputBuffer.subarray(4 + length);
    try {
      void handleMessage(JSON.parse(payload));
    } catch (error) {
      writeMessage({ type: "error", error: `本地消息格式错误：${error.message}` });
    }
  }
}

function validateCwd(cwd) {
  const resolved = path.resolve(cwd || DEFAULT_CWD);
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`项目目录不存在：${resolved}`);
    }
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK);
    return resolved;
  } catch (error) {
    if (error?.message?.startsWith("项目目录不存在")) throw error;
    const downloadsHint = process.platform === "darwin" && resolved.includes(`${path.sep}Downloads${path.sep}`)
      ? " 当前目录位于 Downloads。macOS 可能限制后台 Native Host 访问该目录；建议将代码项目移动到 ~/Developer 或 ~/Projects，或在系统设置 > 隐私与安全性 > 文件与文件夹中检查 Chrome 的文件访问权限。"
      : "";
    throw new Error(`无法访问项目目录：${resolved} (${error?.code || error?.message || error}).${downloadsHint}`);
  }
}

function normalizePermissionMode(mode) {
  return new Set(["default", "acceptEdits", "plan", "auto", "dontAsk"]).has(mode)
    ? mode
    : "default";
}

function buildPageAdditionalContext(pageContext) {
  if (!pageContext?.tabId) return "";
  return `<sidebar_current_page>\nCurrent tabId: ${Number(pageContext.tabId)}\n页面标题: ${pageContext.title || ""}\n页面 URL: ${pageContext.url || ""}\n浏览器图片传输模式: ${BROWSER_IMAGE_MODE}\n\n这是用户此刻在侧栏旁明确选择的当前活动标签页。回答与当前页面有关的问题前，先调用 tabs_context_mcp，并按任务实际使用 read_page、get_page_text、find、computer、console 或 network 工具检查这个精确 tabId。mcp-image 模式下截图直接作为原始 image block 给你查看；视觉问题优先直接看截图。涉及弹窗溢出、footer/primary action 可达性、viewport clipping、fixed/sticky occlusion、scroll trap、内部滚动或修复前后验证时，按需自动使用 inspect_layout(detail=summary)，compact 结果不足时再用 detail=full，具体控件可传 targetText。不要在每次截图后机械调用 inspect_layout，也不要询问用户是否需要测量。safe-text 仅为 Gatekeeper 故障排查模式。除非用户明确要求，否则不要新建标签页。\n</sidebar_current_page>`;
}


function buildAgentThreadAdditionalContext(thread) {
  if (!thread?.agentId) return "";
  return `<sidebar_agent_thread>
The user is directly addressing an existing Claude Code subagent thread.
agentId: ${thread.agentId}
agent name: ${thread.agentName || "subagent"}
threadId: ${thread.threadId || thread.agentId}

Continue that exact subagent by using the Agent tool with resume: "${thread.agentId}".
Do not start a fresh subagent for this message. The user's visible message is addressed to the resumed subagent.
After the resumed subagent responds, preserve its result faithfully instead of replacing it with an unrelated new analysis.
</sidebar_agent_thread>`;
}

function extractAgentId(message) {
  if (message?.type !== "assistant" && message?.type !== "user") return null;
  const content = JSON.stringify(message.message?.content || "");
  return content.match(/agentId:\s*([\w-]+)/)?.[1] || null;
}

function ensureAgentRun(runtime, toolUseId, defaults = {}) {
  if (!toolUseId) return null;
  let run = runtime.agentRuns.get(toolUseId);
  if (run) return run;

  const target = runtime.activeTurn?.targetThread;
  run = {
    toolUseId,
    threadId: defaults.threadId || target?.threadId || toolUseId,
    agentId: defaults.agentId || target?.agentId || null,
    agentName: defaults.agentName || target?.agentName || "subagent",
    description: defaults.description || "",
    status: defaults.status || "running",
    resumable: Boolean(defaults.agentId || target?.agentId),
    deltaBuffer: "",
    deltaBytes: 0,
    deltaTimer: null,
    streamedSinceAssistant: false,
  };
  runtime.agentRuns.set(toolUseId, run);
  writeMessage({
    type: "agent_thread",
    threadId: run.threadId,
    toolUseId: run.toolUseId,
    agentId: run.agentId,
    agentName: run.agentName,
    description: run.description,
    status: run.status,
    resumable: run.resumable,
  });
  return run;
}

function updateAgentRun(run, patch = {}) {
  if (!run) return;
  Object.assign(run, patch);
  run.resumable = Boolean(run.agentId);
  writeMessage({
    type: "agent_thread",
    threadId: run.threadId,
    toolUseId: run.toolUseId,
    agentId: run.agentId,
    agentName: run.agentName,
    description: run.description,
    status: run.status,
    resumable: run.resumable,
  });
}

function flushAgentDelta(run) {
  if (!run) return;
  if (run.deltaTimer) {
    clearTimeout(run.deltaTimer);
    run.deltaTimer = null;
  }
  if (!run.deltaBuffer) return;
  const text = run.deltaBuffer;
  run.deltaBuffer = "";
  run.deltaBytes = 0;
  writeMessage({
    type: "agent_delta",
    threadId: run.threadId,
    toolUseId: run.toolUseId,
    agentId: run.agentId,
    agentName: run.agentName,
    text,
  });
}

function queueAgentDelta(run, text) {
  if (!run || !text) return;
  run.streamedSinceAssistant = true;
  run.deltaBuffer += text;
  run.deltaBytes += Buffer.byteLength(text, "utf8");
  if (run.deltaBytes >= DELTA_FLUSH_BYTES) {
    flushAgentDelta(run);
    return;
  }
  if (!run.deltaTimer) {
    run.deltaTimer = setTimeout(() => flushAgentDelta(run), DELTA_FLUSH_MS);
  }
}

function askUserQuestion(input, options = {}) {
  const questionId = randomUUID();
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  writeMessage({
    type: "question_request",
    questionId,
    questions,
  });

  return new Promise((resolve) => {
    const finish = (result) => {
      const waiter = permissionWaiters.get(questionId);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      options.signal?.removeEventListener?.("abort", waiter.onAbort);
      permissionWaiters.delete(questionId);
      resolve(result);
    };
    const onAbort = () => finish({ behavior: "deny", message: "当前方案选择已被中断。", interrupt: true });
    const timer = setTimeout(() => {
      finish({ behavior: "deny", message: "浏览器侧栏中的方案选择已超时。" });
    }, 600_000);
    permissionWaiters.set(questionId, { kind: "question", input, resolve, timer, onAbort, finish });
    options.signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function canUseTool(toolName, input, options = {}) {
  if (toolName === "AskUserQuestion") return askUserQuestion(input, options);
  if (AUTO_APPROVED_TOOLS.has(toolName)) return Promise.resolve({ behavior: "allow", updatedInput: input });
  if (toolName === "mcp__open-claude-in-chrome__computer") {
    const safeComputerActions = new Set(["screenshot", "wait", "zoom", "hover"]);
    if (safeComputerActions.has(input?.action)) return Promise.resolve({ behavior: "allow", updatedInput: input });
  }

  const permissionId = randomUUID();
  writeMessage({
    type: "permission_request",
    permissionId,
    toolName,
    input,
    decisionReason: options.decisionReason || "",
  });

  return new Promise((resolve) => {
    const finish = (result) => {
      const waiter = permissionWaiters.get(permissionId);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      options.signal?.removeEventListener?.("abort", waiter.onAbort);
      permissionWaiters.delete(permissionId);
      resolve(result);
    };
    const onAbort = () => finish({ behavior: "deny", message: "当前工具请求已被中断。", interrupt: true });
    const timer = setTimeout(() => {
      finish({ behavior: "deny", message: "浏览器侧栏中的权限请求已超时。" });
    }, 120_000);
    permissionWaiters.set(permissionId, { kind: "permission", input, resolve, timer, onAbort, finish });
    options.signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function newTurnUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    seenMessageIds: new Set(),
  };
}

function addAssistantUsage(turn, message) {
  const messageId = message?.id;
  if (messageId && turn.usage.seenMessageIds.has(messageId)) return;
  if (messageId) turn.usage.seenMessageIds.add(messageId);

  const usage = message?.usage || {};
  turn.usage.inputTokens += Number(usage.input_tokens ?? usage.inputTokens ?? 0);
  turn.usage.outputTokens += Number(usage.output_tokens ?? usage.outputTokens ?? 0);
  turn.usage.cacheReadInputTokens += Number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0);
  turn.usage.cacheCreationInputTokens += Number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0);
}

function addModelUsage(turn, modelUsage = {}) {
  for (const usage of Object.values(modelUsage || {})) {
    turn.usage.inputTokens += Number(usage.inputTokens || 0);
    turn.usage.outputTokens += Number(usage.outputTokens || 0);
    turn.usage.cacheReadInputTokens += Number(usage.cacheReadInputTokens || 0);
    turn.usage.cacheCreationInputTokens += Number(usage.cacheCreationInputTokens || 0);
  }
}


function flushDelta(turn) {
  if (!turn) return;
  if (turn.deltaTimer) {
    clearTimeout(turn.deltaTimer);
    turn.deltaTimer = null;
  }
  if (!turn.deltaBuffer) return;
  const text = turn.deltaBuffer;
  turn.deltaBuffer = "";
  turn.deltaBytes = 0;
  turn.deltaFlushes += 1;
  writeMessage({ type: "delta", requestId: turn.requestId, text });
}

function queueDelta(turn, text) {
  if (!turn || !text) return;
  if (!turn.firstTokenAt) turn.firstTokenAt = Date.now();
  if (!turn.firstFeedbackAt) turn.firstFeedbackAt = Date.now();
  turn.streamedText = true;
  turn.deltaBuffer += text;
  turn.deltaBytes += Buffer.byteLength(text, "utf8");

  if (turn.deltaBytes >= DELTA_FLUSH_BYTES) {
    flushDelta(turn);
    return;
  }
  if (!turn.deltaTimer) {
    turn.deltaTimer = setTimeout(() => flushDelta(turn), DELTA_FLUSH_MS);
  }
}

function emitActivity(turn, activity, detail = "") {
  if (!turn) return;
  const key = `${activity}:${detail}`;
  const now = Date.now();
  if (!turn.firstFeedbackAt) turn.firstFeedbackAt = now;
  if (turn.lastActivityKey === key && now - turn.lastActivityAt < ACTIVITY_MIN_INTERVAL_MS) return;
  turn.lastActivityKey = key;
  turn.lastActivityAt = now;
  writeMessage({
    type: "activity",
    requestId: turn.requestId,
    activity,
    detail,
  });
}

function activateNextTurn(runtime) {
  if (!runtime || runtime.closed || runtime.activeTurn || runtime.pendingTurns.length === 0) return;
  const next = runtime.pendingTurns.shift();
  next.startedAt = Date.now();
  runtime.activeTurn = next;
  writeMessage({
    type: "turn_started",
    requestId: next.requestId,
    queuedForMs: next.startedAt - next.enqueuedAt,
    remainingQueued: runtime.pendingTurns.length,
  });
}

function buildPerformance(turn, extra = {}) {
  const inputTokens = turn.usage.inputTokens;
  const outputTokens = turn.usage.outputTokens;
  const cacheReadInputTokens = turn.usage.cacheReadInputTokens;
  const cacheCreationInputTokens = turn.usage.cacheCreationInputTokens;
  const cacheDenominator = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  return {
    firstFeedbackMs: turn.firstFeedbackAt ? turn.firstFeedbackAt - turn.startedAt : null,
    ttftMs: turn.firstTokenAt ? turn.firstTokenAt - turn.startedAt : null,
    totalMs: Date.now() - turn.startedAt,
    nativeDeltaMessages: turn.deltaFlushes,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    cacheHitRate: cacheDenominator > 0 ? cacheReadInputTokens / cacheDenominator : null,
    ...extra,
  };
}

function finishTurn(runtime, { result = "", event = null, interrupted = false } = {}) {
  const turn = runtime.activeTurn;
  if (!turn || turn.finished) return;
  flushDelta(turn);
  turn.finished = true;

  if (event?.modelUsage) {
    turn.usage = newTurnUsage();
    addModelUsage(turn, event.modelUsage);
  }

  const performance = buildPerformance(turn, {
    apiDurationMs: event?.duration_api_ms ?? null,
    costUsd: event?.total_cost_usd ?? null,
    numTurns: event?.num_turns ?? null,
  });

  runtime.activeTurn = null;

  if (interrupted) {
    writeMessage({ type: "interrupted", requestId: turn.requestId, performance });
  } else {
    writeMessage({
      type: "done",
      requestId: turn.requestId,
      sessionId: runtime.sessionId || currentSessionId,
      result: turn.streamedText ? "" : (result || turn.fallbackText),
      performance,
    });
  }

  activateNextTurn(runtime);
}

function isFinalAssistantStop(stopReason) {
  return Boolean(stopReason) && stopReason !== "tool_use" && stopReason !== "pause_turn";
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function stripLegacyPageContext(text) {
  return String(text || "")
    .replace(/\n\n<sidebar_current_page>[\s\S]*?<\/sidebar_current_page>\s*$/m, "")
    .trim();
}

function normalizeTranscriptMessages(messages) {
  const normalized = [];
  for (const entry of messages) {
    if (!entry || (entry.type !== "user" && entry.type !== "assistant")) continue;
    if (entry.parent_tool_use_id) continue;
    if (entry.isSynthetic) continue;

    let text = extractText(entry.message?.content);
    if (entry.type === "user") text = stripLegacyPageContext(text);
    text = text.trim();
    if (!text) continue;

    if (text.length > HISTORY_TEXT_LIMIT) {
      text = `${text.slice(0, HISTORY_TEXT_LIMIT)}\n\n…[历史消息过长，侧栏已截断显示]`;
    }
    normalized.push({
      role: entry.type,
      text,
      uuid: entry.uuid || null,
    });
  }
  return normalized.slice(-HISTORY_MESSAGE_LIMIT);
}

function runtimeMatches(runtime, config) {
  if (!runtime || runtime.closed) return false;
  const requestedSessionId = config.sessionId || null;
  const runtimeSessionId = runtime.sessionId || runtime.requestedSessionId || null;
  const sameBaseConfig = runtime.cwd === config.cwd
    && runtime.model === (config.model || "")
    && runtime.permissionMode === config.permissionMode;
  if (!sameBaseConfig) return false;

  // A freshly prepared runtime starts without a session ID. The SDK assigns one
  // asynchronously in the init event. Reuse that runtime when the side panel has
  // not received the assigned ID yet instead of cold-restarting Claude.
  if (requestedSessionId === null && runtime.requestedSessionId === null) return true;
  return runtimeSessionId === requestedSessionId;
}

async function closeRuntime(runtime = currentRuntime) {
  if (!runtime || runtime.closed) return;
  runtime.closed = true;
  if (runtime.activeTurn && !runtime.activeTurn.finished) {
    finishTurn(runtime, { interrupted: true });
  }
  runtime.queue.close();
  runtime.pageContextQueue.length = 0;
  runtime.threadRouteQueue.length = 0;
  runtime.pendingTurns.length = 0;
  for (const run of runtime.agentRuns.values()) {
    if (run.deltaTimer) clearTimeout(run.deltaTimer);
  }
  runtime.agentRuns.clear();
  try { runtime.query?.close?.(); } catch {}
  if (currentRuntime === runtime) currentRuntime = null;
}

async function consumeRuntime(runtime) {
  try {
    for await (const event of runtime.query) {
      if (event.session_id) {
        runtime.sessionId = event.session_id;
        currentSessionId = event.session_id;
      }

      if (event.type === "system" && event.subtype === "init") {
        writeMessage({
          type: "session",
          sessionId: event.session_id,
          model: event.model,
          cwd: event.cwd,
          mcpServers: event.mcp_servers,
        });
        if (!runtime.capabilitiesPublished) {
          writeMessage({
            type: "capabilities_fallback",
            commands: (event.slash_commands || []).map((name) => ({ name, description: "", argumentHint: "" })),
            agents: (event.agents || []).map((name) => ({ name, description: "", model: undefined })),
            model: event.model || "",
            tools: event.tools || [],
            skills: event.skills || [],
          });
        }
        continue;
      }

      if (event.type === "system" && event.subtype === "status") {
        const turn = runtime.activeTurn;
        if (event.status === "compacting") emitActivity(turn, "compacting");
        else if (turn) emitActivity(turn, "working");
        writeMessage({
          type: "runtime_status",
          requestId: turn?.requestId || null,
          status: event.status || null,
          permissionMode: event.permissionMode || null,
        });
        continue;
      }

      if (event.type === "system" && ["task_started", "task_progress", "task_notification"].includes(event.subtype)) {
        const taskStatus = event.status || (event.subtype === "task_started" ? "running" : undefined);
        if (event.tool_use_id && runtime.agentRuns.has(event.tool_use_id)) {
          const run = runtime.agentRuns.get(event.tool_use_id);
          updateAgentRun(run, {
            status: taskStatus || run.status,
            description: event.description || event.summary || run.description,
          });
        }
        writeMessage({
          type: "agent_task",
          subtype: event.subtype,
          taskId: event.task_id,
          toolUseId: event.tool_use_id || null,
          description: event.description || event.summary || "Agent task",
          status: taskStatus,
          usage: event.usage || null,
          lastToolName: event.last_tool_name || null,
          summary: event.summary || "",
        });
        continue;
      }

      const turn = runtime.activeTurn;

      if (event.type === "tool_progress") {
        if (event.parent_tool_use_id) {
          const run = ensureAgentRun(runtime, event.parent_tool_use_id);
          flushAgentDelta(run);
          writeMessage({
            type: "agent_activity",
            threadId: run?.threadId || event.parent_tool_use_id,
            toolUseId: event.parent_tool_use_id,
            activity: "tool",
            name: event.tool_name,
            elapsedSeconds: event.elapsed_time_seconds || 0,
          });
        } else if (turn) {
          flushDelta(turn);
          writeMessage({
            type: "tool_progress",
            requestId: turn.requestId,
            toolUseId: event.tool_use_id,
            name: event.tool_name,
            elapsedSeconds: event.elapsed_time_seconds || 0,
            taskId: event.task_id || null,
          });
        }
        continue;
      }

      if (event.type === "user" && event.parent_tool_use_id) {
        const run = ensureAgentRun(runtime, event.parent_tool_use_id);
        const agentId = extractAgentId(event);
        if (agentId) updateAgentRun(run, { agentId, status: "completed" });
        continue;
      }

      if (event.type === "rate_limit_event") {
        writeMessage({
          type: "rate_limit",
          requestId: turn?.requestId || null,
          info: event.rate_limit_info || {},
        });
        continue;
      }

      if (event.type === "system" && event.subtype === "local_command_output") {
        if (turn) flushDelta(turn);
        writeMessage({
          type: "local_output",
          requestId: turn?.requestId || null,
          content: event.content || "",
        });
        continue;
      }

      if (event.type === "prompt_suggestion") {
        writeMessage({
          type: "prompt_suggestion",
          requestId: turn?.requestId || null,
          suggestion: event.suggestion || "",
        });
        continue;
      }

      if (event.type === "stream_event") {
        if (!turn) continue;
        const raw = event.event || {};
        const delta = raw.delta;

        if (event.parent_tool_use_id) {
          const run = ensureAgentRun(runtime, event.parent_tool_use_id);
          emitActivity(turn, "agent_working", run?.agentName || "subagent");

          if (raw.type === "content_block_start") {
            if (raw.content_block?.type === "thinking") {
              writeMessage({
                type: "agent_activity",
                threadId: run?.threadId || event.parent_tool_use_id,
                toolUseId: event.parent_tool_use_id,
                activity: "thinking",
              });
            } else if (raw.content_block?.type === "text") {
              run.streamedSinceAssistant = false;
            } else if (raw.content_block?.type === "tool_use") {
              flushAgentDelta(run);
              writeMessage({
                type: "agent_activity",
                threadId: run?.threadId || event.parent_tool_use_id,
                toolUseId: event.parent_tool_use_id,
                activity: "tool",
                name: raw.content_block.name || "tool",
                elapsedSeconds: 0,
              });
            }
            continue;
          }

          if (delta?.type === "text_delta" && delta.text) {
            queueAgentDelta(run, delta.text);
          } else if (delta?.type === "thinking_delta") {
            writeMessage({
              type: "agent_activity",
              threadId: run?.threadId || event.parent_tool_use_id,
              toolUseId: event.parent_tool_use_id,
              activity: "thinking",
            });
          } else if (delta?.type === "input_json_delta") {
            writeMessage({
              type: "agent_activity",
              threadId: run?.threadId || event.parent_tool_use_id,
              toolUseId: event.parent_tool_use_id,
              activity: "preparing_tool",
            });
          }

          if (raw.type === "content_block_stop" || raw.type === "message_stop") {
            flushAgentDelta(run);
          }
          continue;
        }

        if (raw.type === "message_start") {
          emitActivity(turn, "working");
          continue;
        }

        if (raw.type === "content_block_start") {
          if (raw.content_block?.type === "thinking") emitActivity(turn, "thinking");
          else if (raw.content_block?.type === "text") emitActivity(turn, "responding");
          else if (raw.content_block?.type === "tool_use") {
            flushDelta(turn);
            writeMessage({
              type: "tool_stream_start",
              requestId: turn.requestId,
              toolUseId: raw.content_block.id || null,
              name: raw.content_block.name || "tool",
            });
          }
          continue;
        }

        if (delta?.type === "text_delta" && delta.text) {
          queueDelta(turn, delta.text);
        } else if (delta?.type === "thinking_delta") {
          emitActivity(turn, "thinking");
        } else if (delta?.type === "input_json_delta") {
          emitActivity(turn, "preparing_tool");
        }

        if (raw.type === "content_block_stop" || raw.type === "message_stop") {
          flushDelta(turn);
        }
        continue;
      }

      if (event.type === "assistant") {
        if (!turn) continue;
        addAssistantUsage(turn, event.message);

        if (event.parent_tool_use_id) {
          const run = ensureAgentRun(runtime, event.parent_tool_use_id);
          flushAgentDelta(run);
          const agentId = extractAgentId(event);
          if (agentId) updateAgentRun(run, { agentId });

          for (const block of event.message?.content || []) {
            if (block.type === "tool_use") {
              writeMessage({
                type: "agent_activity",
                threadId: run?.threadId || event.parent_tool_use_id,
                toolUseId: event.parent_tool_use_id,
                activity: "tool",
                name: block.name,
                elapsedSeconds: 0,
              });
            } else if (block.type === "text" && block.text && !run.streamedSinceAssistant) {
              writeMessage({
                type: "agent_message",
                threadId: run.threadId,
                toolUseId: run.toolUseId,
                agentId: run.agentId,
                agentName: run.agentName,
                role: "assistant",
                text: block.text,
              });
            }
          }
          run.streamedSinceAssistant = false;
          if (isFinalAssistantStop(event.message?.stop_reason)) {
            writeMessage({
              type: "agent_turn_end",
              threadId: run.threadId,
              toolUseId: run.toolUseId,
              agentId: run.agentId,
              agentName: run.agentName,
            });
          }
          continue;
        }

        flushDelta(turn);

        for (const block of event.message?.content || []) {
          if (block.type === "tool_use") {
            writeMessage({ type: "tool", requestId: turn.requestId, name: block.name, input: block.input });
            if (block.name === "Agent" || block.name === "Task") {
              const requestedAgentId = block.input?.resume || null;
              const existingRun = requestedAgentId
                ? Array.from(runtime.agentRuns.values()).find((candidate) => candidate.agentId === requestedAgentId)
                : null;
              const target = turn.targetThread?.agentId === requestedAgentId ? turn.targetThread : null;
              const run = ensureAgentRun(runtime, block.id, {
                threadId: existingRun?.threadId || target?.threadId || block.id,
                agentId: requestedAgentId || existingRun?.agentId || target?.agentId || null,
                agentName: block.input?.subagent_type || target?.agentName || existingRun?.agentName || "general-purpose",
                description: block.input?.description || existingRun?.description || "",
                status: "running",
              });
              writeMessage({
                type: "agent_invoked",
                requestId: turn.requestId,
                threadId: run?.threadId || block.id || null,
                toolUseId: block.id || null,
                agentId: run?.agentId || null,
                agentName: run?.agentName || "general-purpose",
                description: run?.description || "",
                prompt: block.input?.prompt || "",
                background: block.input?.run_in_background !== false,
                resumed: Boolean(block.input?.resume),
              });
            }
          } else if (block.type === "text" && block.text && !turn.streamedText) {
            turn.fallbackText += block.text;
          }
        }

        if (event.error) {
          writeMessage({ type: "error", requestId: turn.requestId, error: `Claude Code 错误：${event.error}` });
          runtime.activeTurn = null;
          activateNextTurn(runtime);
          continue;
        }

        if (isFinalAssistantStop(event.message?.stop_reason)) {
          finishTurn(runtime, { result: turn.fallbackText });
        }
        continue;
      }

      if (event.type === "result" && turn) {
        flushDelta(turn);
        if (event.subtype === "success") {
          finishTurn(runtime, { result: event.result || "", event });
        } else {
          const errorText = (event.errors || [event.subtype]).join("\n");
          writeMessage({ type: "error", requestId: turn.requestId, error: errorText });
          runtime.activeTurn = null;
          activateNextTurn(runtime);
        }
      }
    }
  } catch (error) {
    if (!runtime.closed) {
      const turn = runtime.activeTurn;
      if (turn) flushDelta(turn);
      writeMessage({
        type: "error",
        requestId: turn?.requestId,
        error: error?.stack || error?.message || String(error),
      });
      runtime.activeTurn = null;
      activateNextTurn(runtime);
    }
  } finally {
    runtime.closed = true;
    if (currentRuntime === runtime) currentRuntime = null;
  }
}

async function publishCapabilities(runtime) {
  try {
    writeMessage({
      type: "boot_state",
      stage: "loading_capabilities",
      text: "Claude Code 已启动 · 正在读取 Commands / Agents…",
    });
    const init = await runtime.query.initializationResult();
    if (runtime.closed) return false;
    runtime.capabilitiesPublished = true;
    writeMessage({
      type: "capabilities",
      commands: init.commands || [],
      agents: init.agents || [],
      models: init.models || [],
      outputStyle: init.output_style || "",
      availableOutputStyles: init.available_output_styles || [],
      fastModeState: init.fast_mode_state || null,
    });
    return true;
  } catch (error) {
    if (!runtime.closed) {
      writeMessage({ type: "capabilities_error", error: `读取 Claude Code 命令与 Agent 列表失败：${errorText(error)}` });
    }
    return false;
  }
}

async function startRuntime(config) {
  await closeRuntime();
  const { query } = await loadAgentSdk();

  writeMessage({
    type: "boot_state",
    stage: "starting_runtime",
    text: "Claude Code Runtime 正在启动…",
  });

  const runtime = {
    cwd: config.cwd,
    model: config.model || "",
    permissionMode: config.permissionMode,
    requestedSessionId: config.sessionId || null,
    sessionId: config.sessionId || null,
    queue: new AsyncMessageQueue(),
    query: null,
    loopPromise: null,
    activeTurn: null,
    pendingTurns: [],
    pageContextQueue: [],
    threadRouteQueue: [],
    agentRuns: new Map(),
    capabilitiesPublished: false,
    capabilitiesPromise: null,
    closed: false,
  };

  const userPromptContextHook = async () => {
    const pageContext = runtime.pageContextQueue.shift() || null;
    persistBrowserContext(pageContext);
    const threadRoute = runtime.threadRouteQueue.shift() || null;
    const additionalContext = [
      buildPageAdditionalContext(pageContext),
      buildAgentThreadAdditionalContext(threadRoute),
    ].filter(Boolean).join("\n\n");
    if (!additionalContext) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    };
  };

  runtime.query = query({
    prompt: runtime.queue,
    options: {
      cwd: runtime.cwd,
      resume: runtime.requestedSessionId || undefined,
      includePartialMessages: true,
      persistSession: true,
      permissionMode: runtime.permissionMode,
      canUseTool,
      tools: { type: "preset", preset: "claude_code" },
      allowedTools: [...AUTO_APPROVED_TOOLS],
      toolConfig: {
        askUserQuestion: { previewFormat: "markdown" },
      },
      settingSources: ["user", "project", "local"],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: SIDEBAR_SYSTEM_PROMPT,
      },
      hooks: {
        UserPromptSubmit: [{ hooks: [userPromptContextHook] }],
      },
      mcpServers: {
        "open-claude-in-chrome": {
          type: "stdio",
          command: process.execPath,
          args: [MCP_SERVER_PATH],
        },
      },
      ...(runtime.model ? { model: runtime.model } : {}),
      ...claudeExecutableOptions(),
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "open-claude-sidebar",
      },
    },
  });

  currentRuntime = runtime;
  runtime.loopPromise = consumeRuntime(runtime);
  runtime.capabilitiesPromise = publishCapabilities(runtime);
  return runtime;
}

async function ensureRuntime(message) {
  const cwd = validateCwd(message.cwd);
  const config = {
    cwd,
    model: message.model || "",
    permissionMode: normalizePermissionMode(message.permissionMode),
    sessionId: message.sessionId || null,
  };
  if (runtimeMatches(currentRuntime, config)) return currentRuntime;
  return startRuntime(config);
}

async function prepareRuntime(message) {
  try {
    const runtime = await ensureRuntime({
      cwd: message.cwd || DEFAULT_CWD,
      model: message.model,
      permissionMode: message.permissionMode,
      sessionId: message.sessionId || null,
    });

    const capabilities = await Promise.race([
      runtime.capabilitiesPromise.then((ok) => ({ status: ok ? "loaded" : "error" })),
      new Promise((resolve) => setTimeout(() => resolve({ status: "pending" }), 12_000)),
    ]);

    writeMessage({
      type: "session_prepared",
      sessionId: runtime.sessionId || runtime.requestedSessionId || null,
      cwd: runtime.cwd,
      capabilitiesStatus: capabilities.status,
    });
  } catch (error) {
    writeMessage({
      type: "boot_error",
      stage: "starting_runtime",
      error: `初始化 Claude Code Session 失败：${errorText(error)}`,
    });
  }
}

async function runChat(message) {
  try {
    const runtime = await ensureRuntime(message);
    const turn = {
      requestId: message.requestId,
      enqueuedAt: Date.now(),
      startedAt: null,
      firstTokenAt: null,
      firstFeedbackAt: null,
      streamedText: false,
      fallbackText: "",
      deltaBuffer: "",
      deltaBytes: 0,
      deltaTimer: null,
      deltaFlushes: 0,
      lastActivityKey: "",
      lastActivityAt: 0,
      usage: newTurnUsage(),
      targetThread: message.thread?.agentId ? {
        threadId: message.thread.threadId || message.thread.agentId,
        agentId: message.thread.agentId,
        agentName: message.thread.agentName || "subagent",
      } : null,
      finished: false,
    };

    if (!runtime.activeTurn) {
      turn.startedAt = Date.now();
      runtime.activeTurn = turn;
      writeMessage({
        type: "turn_started",
        requestId: turn.requestId,
        queuedForMs: 0,
        remainingQueued: runtime.pendingTurns.length,
      });
    } else {
      runtime.pendingTurns.push(turn);
      writeMessage({
        type: "queued",
        requestId: turn.requestId,
        position: runtime.pendingTurns.length,
      });
    }

    runtime.pageContextQueue.push(message.pageContext || null);
    runtime.threadRouteQueue.push(turn.targetThread);
    runtime.queue.push({
      type: "user",
      message: {
        role: "user",
        content: message.prompt,
      },
      parent_tool_use_id: null,
    });
  } catch (error) {
    writeMessage({ type: "error", requestId: message.requestId, error: error?.stack || error?.message || String(error) });
  }
}

async function listHistory(message) {
  try {
    const { listSessions } = await loadAgentSdk();
    const dir = message.cwd ? validateCwd(message.cwd) : undefined;
    const sessions = await listSessions({ dir, limit: HISTORY_LIMIT });
    writeMessage({
      type: "sessions",
      sessions: sessions.map((session) => ({
        sessionId: session.sessionId,
        summary: session.summary || "未命名会话",
        lastModified: session.lastModified,
        cwd: session.cwd || null,
        gitBranch: session.gitBranch || null,
        customTitle: session.customTitle || null,
      })),
    });
  } catch (error) {
    writeMessage({ type: "error", error: `读取历史会话失败：${error.message}` });
  }
}

async function loadHistoryMessages(message) {
  try {
    const { getSessionMessages } = await loadAgentSdk();
    const options = {
      ...(message.cwd ? { dir: validateCwd(message.cwd) } : {}),
    };
    const messages = await getSessionMessages(message.sessionId, options);
    writeMessage({
      type: "session_messages",
      sessionId: message.sessionId,
      cwd: message.cwd || null,
      messages: normalizeTranscriptMessages(messages),
    });
  } catch (error) {
    writeMessage({ type: "error", error: `读取会话记录失败：${error.message}` });
  }
}

async function selectSession(message) {
  try {
    const runtime = await ensureRuntime({
      cwd: message.cwd || DEFAULT_CWD,
      model: message.model,
      permissionMode: message.permissionMode,
      sessionId: message.sessionId,
    });
    currentSessionId = message.sessionId;
    writeMessage({
      type: "session_selected",
      sessionId: message.sessionId,
      cwd: runtime.cwd,
    });
  } catch (error) {
    writeMessage({ type: "error", error: `恢复历史会话失败：${error.message}` });
  }
}

async function interruptCurrentTurn(message) {
  const runtime = currentRuntime;
  if (!runtime?.activeTurn) return;
  if (message.requestId && runtime.activeTurn.requestId !== message.requestId) return;
  try {
    await runtime.query.interrupt();
  } catch {}
  finishTurn(runtime, { interrupted: true });
}

async function handleMessage(message) {
  // CLAUDE_SIDEBAR_V611_CHAT_ATTACHMENT_INGRESS
  if (Array.isArray(message?.attachments) && message.attachments.length) __claudeSidebarAttachmentStore.prepareChatMessageAttachments(message);
  // CLAUDE_SIDEBAR_V6121_CHAT_CANCELLATION_INGRESS
  const __claudeSidebarCancellation = __claudeSidebarCancellationRuntime.handleIncomingMessage(message);
  if (__claudeSidebarCancellation?.handled) return __claudeSidebarCancellation.response;
  switch (message.type) {
    case "hello":
      writeMessage({
        type: "hello",
        claudePath: CLAUDE_RUNTIME_MODE === "external-cli" ? (EXTERNAL_CLAUDE_PATH || null) : null,
        externalClaudePath: EXTERNAL_CLAUDE_PATH || null,
        runtimeMode: CLAUDE_RUNTIME_MODE,
        imageMode: BROWSER_IMAGE_MODE,
        cwd: DEFAULT_CWD,
        engine: "persistent-streaming-input-batched",
        hostVersion: "6.3.3",
        transportMode: DAEMON_MODE ? "detached-daemon" : "native-direct",
        daemonSocketPath: DAEMON_MODE ? DAEMON_SOCKET_PATH : null,
        browserContextFile: BROWSER_CONTEXT_FILE,
        hostScript: fileURLToPath(import.meta.url),
        hostDir: __dirname,
        mcpServerPath: MCP_SERVER_PATH,
        sourceRoot: process.env.CLAUDE_SIDEBAR_SOURCE_ROOT || null,
        nodeVersion: process.version,
      });
      if (CLAUDE_RUNTIME_MODE === "external-cli" && !EXTERNAL_CLAUDE_PATH) {
        writeMessage({
          type: "boot_warning",
          stage: "claude_path",
          text: "External CLI mode 已启用，但未找到 claude 可执行文件。请重新运行 install-sidebar-host.sh，或使用默认 sdk-builtin 模式。",
        });
      }
      break;
    case "prepare_session":
      await prepareRuntime(message);
      break;
    case "chat":
      await runChat(message);
      break;
    case "interrupt":
      await interruptCurrentTurn(message);
      break;
    case "new_session":
      await closeRuntime();
      currentSessionId = null;
      writeMessage({ type: "new_session_ready" });
      break;
    case "list_sessions":
      await listHistory(message);
      break;
    case "get_session_messages":
      await loadHistoryMessages(message);
      break;
    case "select_session":
      await selectSession(message);
      break;
    case "permission_response": {
      const waiter = permissionWaiters.get(message.permissionId);
      if (!waiter || waiter.kind !== "permission") break;
      waiter.finish(message.allow
        ? { behavior: "allow", updatedInput: waiter.input }
        : { behavior: "deny", message: "用户已在浏览器侧栏中拒绝此操作。" });
      break;
    }
    case "question_response": {
      const waiter = permissionWaiters.get(message.questionId);
      if (!waiter || waiter.kind !== "question") break;
      const answers = message.answers && typeof message.answers === "object" ? message.answers : {};
      waiter.finish({
        behavior: "allow",
        updatedInput: {
          questions: waiter.input?.questions || [],
          answers,
          ...(message.response ? { response: String(message.response) } : {}),
        },
      });
      break;
    }
  }
}

if (process.argv.includes("--self-test")) {
  const result = {
    nodeVersion: process.version,
    runtimeMode: CLAUDE_RUNTIME_MODE,
    imageMode: BROWSER_IMAGE_MODE,
    transportMode: DAEMON_MODE ? "detached-daemon" : "native-direct",
    daemonSocketPath: DAEMON_SOCKET_PATH,
    browserContextFile: BROWSER_CONTEXT_FILE,
    claudePath: CLAUDE_RUNTIME_MODE === "external-cli" ? (EXTERNAL_CLAUDE_PATH || null) : null,
    externalClaudePath: EXTERNAL_CLAUDE_PATH || null,
    hostScript: fileURLToPath(import.meta.url),
    hostDir: __dirname,
    mcpServerPath: MCP_SERVER_PATH,
    mcpServerExists: fs.existsSync(MCP_SERVER_PATH),
    sourceRoot: process.env.CLAUDE_SIDEBAR_SOURCE_ROOT || null,
    sdkLoaded: false,
    sdkError: null,
  };
  try {
    await import("@anthropic-ai/claude-agent-sdk");
    result.sdkLoaded = true;
  } catch (error) {
    result.sdkError = errorText(error);
  }
  console.log(JSON.stringify(result, null, 2));
  const executableOk = CLAUDE_RUNTIME_MODE !== "external-cli" || Boolean(result.claudePath);
  process.exit(result.sdkLoaded && executableOk && result.mcpServerExists ? 0 : 1);
}

async function shutdownDaemon(exitCode = 0) {
  try { await closeRuntime(); } catch {}
  if (activeRelaySocket && !activeRelaySocket.destroyed) {
    try { activeRelaySocket.destroy(); } catch {}
  }
  if (daemonServer) {
    try { daemonServer.close(); } catch {}
  }
  try {
    if (DAEMON_MODE && fs.existsSync(DAEMON_SOCKET_PATH)) fs.unlinkSync(DAEMON_SOCKET_PATH);
  } catch {}
  process.exit(exitCode);
}

function startDetachedDaemonTransport() {
  try {
    if (fs.existsSync(DAEMON_SOCKET_PATH)) fs.unlinkSync(DAEMON_SOCKET_PATH);
  } catch (error) {
    process.stderr.write(`failed to clear stale daemon socket: ${errorText(error)}\n`);
  }

  daemonServer = net.createServer((socket) => {
    if (activeRelaySocket && activeRelaySocket !== socket && !activeRelaySocket.destroyed) {
      try { activeRelaySocket.destroy(); } catch {}
    }
    activeRelaySocket = socket;
    socket.setEncoding("utf8");
    let lineBuffer = "";

    socket.on("data", (chunk) => {
      lineBuffer += chunk;
      let newlineIndex;
      while ((newlineIndex = lineBuffer.indexOf("\n")) !== -1) {
        const line = lineBuffer.slice(0, newlineIndex).trim();
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          void handleMessage(JSON.parse(line));
        } catch (error) {
          writeMessage({ type: "error", error: `daemon message parse failed: ${error.message}` });
        }
      }
    });

    socket.on("error", (error) => {
      process.stderr.write(`daemon relay socket error: ${errorText(error)}\n`);
    });

    socket.on("close", () => {
      if (activeRelaySocket === socket) activeRelaySocket = null;
      // Deliberately keep Agent SDK / Claude runtime alive. The browser relay may
      // reconnect without moving Claude back into Chrome's process tree.
    });
  });

  daemonServer.on("error", (error) => {
    process.stderr.write(`Claude Sidebar daemon server failed: ${errorText(error)}\n`);
    void shutdownDaemon(1);
  });

  daemonServer.listen(DAEMON_SOCKET_PATH, () => {
    try { fs.chmodSync(DAEMON_SOCKET_PATH, 0o600); } catch {}
    process.stderr.write(`Claude Sidebar detached daemon listening on ${DAEMON_SOCKET_PATH}\n`);
  });
}

if (DAEMON_MODE) {
  startDetachedDaemonTransport();
} else {
  process.stdin.on("data", (chunk) => {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    parseMessages();
  });

  process.stdin.on("end", async () => {
    await closeRuntime();
    process.exit(0);
  });
}

process.on("SIGTERM", async () => {
  if (DAEMON_MODE) await shutdownDaemon(0);
  else {
    await closeRuntime();
    process.exit(0);
  }
});

process.on("SIGINT", async () => {
  if (DAEMON_MODE) await shutdownDaemon(0);
  else {
    await closeRuntime();
    process.exit(0);
  }
});

process.on("uncaughtException", (error) => {
  const text = error?.stack || String(error);
  process.stderr.write(`${text}\n`);
  writeMessage({ type: "error", error: text });
});

process.on("unhandledRejection", (error) => {
  const text = error?.stack || String(error);
  process.stderr.write(`${text}\n`);
  writeMessage({ type: "error", error: text });
});
