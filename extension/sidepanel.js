const CHAT_HOST = "com.anthropic.claude_sidebar_chat";
const THREAD_STORAGE_KEY = "claudeSidebarAgentThreadsV1";
const THREAD_MESSAGE_LIMIT = 120;
const THREAD_TEXT_LIMIT = 50_000;


const els = {
  status: document.querySelector("#status"),
  reconnectButton: document.querySelector("#reconnectButton"),
  messages: document.querySelector("#messages"),
  contextStack: document.querySelector("#contextStack"),
  emptyState: document.querySelector("#emptyState"),
  pageContext: document.querySelector("#pageContext"),
  pageTitle: document.querySelector("#pageTitle"),
  pageUrl: document.querySelector("#pageUrl"),
  threadBar: document.querySelector("#threadBar"),
  mainThreadButton: document.querySelector("#mainThreadButton"),
  threadTabs: document.querySelector("#threadTabs"),
  promptInput: document.querySelector("#promptInput"),
  sendButton: document.querySelector("#sendButton"),
  stopButton: document.querySelector("#stopButton"),
  newChatButton: document.querySelector("#newChatButton"),
  agentsButton: document.querySelector("#agentsButton"),
  historyButton: document.querySelector("#historyButton"),
  settingsButton: document.querySelector("#settingsButton"),
  settingsDialog: document.querySelector("#settingsDialog"),
  cwdInput: document.querySelector("#cwdInput"),
  modelInput: document.querySelector("#modelInput"),
  modelOptions: document.querySelector("#modelOptions"),
  permissionModeInput: document.querySelector("#permissionModeInput"),
  includePageContextInput: document.querySelector("#includePageContextInput"),
  saveSettingsButton: document.querySelector("#saveSettingsButton"),
  questionPanel: document.querySelector("#questionPanel"),
  questionList: document.querySelector("#questionList"),
  submitQuestion: document.querySelector("#submitQuestion"),
  permissionPanel: document.querySelector("#permissionPanel"),
  permissionTool: document.querySelector("#permissionTool"),
  permissionInput: document.querySelector("#permissionInput"),
  allowPermission: document.querySelector("#allowPermission"),
  denyPermission: document.querySelector("#denyPermission"),
  commandMenu: document.querySelector("#commandMenu"),
  agentActivityList: document.querySelector("#agentActivityList"),
  toolActivity: document.querySelector("#toolActivity"),
  performanceBar: document.querySelector("#performanceBar"),
  sessionLabel: document.querySelector("#sessionLabel"),
  agentsBackdrop: document.querySelector("#agentsBackdrop"),
  agentsDrawer: document.querySelector("#agentsDrawer"),
  agentsList: document.querySelector("#agentsList"),
  closeAgentsButton: document.querySelector("#closeAgentsButton"),
  historyBackdrop: document.querySelector("#historyBackdrop"),
  historyDrawer: document.querySelector("#historyDrawer"),
  historyList: document.querySelector("#historyList"),
  closeHistoryButton: document.querySelector("#closeHistoryButton"),
  historyNewChatButton: document.querySelector("#historyNewChatButton"),
};

const state = {
  port: null,
  connected: false,
  busy: false,
  requestId: null,
  sessionId: null,
  sessionCwd: null,
  activeThreadId: "main",
  threadMessages: new Map([["main", []]]),
  threadStreams: new Map(),
  agentThreads: new Map(),
  requestThreads: new Map(),
  savedThreadStore: {},
  threadPersistTimer: null,
  queuedRequestIds: new Set(),
  currentPage: null,
  currentPermission: null,
  currentQuestion: null,
  commands: [],
  agents: [],
  models: [],
  agentTasks: new Map(),
  sessions: [],
  restoredLastSession: false,
  lastSession: null,
  connectionAttempt: 0,
  helloTimer: null,
  reconnectTimer: null,
  stableConnectionTimer: null,
  disconnectTimes: [],
  reconnectPaused: false,
  settings: {
    cwd: "",
    model: "",
    permissionMode: "default",
    includePageContext: true,
  },
};

function setStatus(text, ok = false) {
  els.status.textContent = text;
  els.status.dataset.ok = String(ok);
}

function activeCwd() {
  if (state.sessionId && state.sessionCwd) return state.sessionCwd;
  return state.settings.cwd || undefined;
}

function postNative(message) {
  if (!state.port) return false;
  try {
    state.port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function clearReconnectTimer() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
}

function clearStableConnectionTimer() {
  if (state.stableConnectionTimer) clearTimeout(state.stableConnectionTimer);
  state.stableConnectionTimer = null;
}

function pauseReconnect(reason) {
  clearReconnectTimer();
  state.reconnectPaused = true;
  els.reconnectButton.hidden = false;
  setStatus(`${reason} · 已暂停自动重连`);
}

function scheduleReconnect(reason = "Claude Code 桥接断开") {
  clearReconnectTimer();
  clearStableConnectionTimer();
  const now = Date.now();
  state.disconnectTimes = state.disconnectTimes.filter((timestamp) => now - timestamp < 30_000);
  state.disconnectTimes.push(now);

  if (state.disconnectTimes.length >= 3) {
    pauseReconnect(`${reason}（30 秒内已断开 ${state.disconnectTimes.length} 次）`);
    return;
  }

  if (state.reconnectPaused) return;
  state.reconnectTimer = setTimeout(connect, 1500);
}

function resetReconnectBreaker() {
  clearReconnectTimer();
  clearStableConnectionTimer();
  state.disconnectTimes = [];
  state.reconnectPaused = false;
  els.reconnectButton.hidden = true;
}

function connect() {
  if (state.port || state.reconnectPaused) return;
  const attempt = ++state.connectionAttempt;
  setStatus("正在连接本地 Native Host…");
  try {
    state.port = chrome.runtime.connectNative(CHAT_HOST);
    state.port.onMessage.addListener(handleNativeMessage);
    state.port.onDisconnect.addListener(() => {
      if (state.helloTimer) clearTimeout(state.helloTimer);
      state.helloTimer = null;
      clearStableConnectionTimer();
      state.connected = false;
      state.busy = false;
      state.requestId = null;
      state.queuedRequestIds.clear();
      state.port = null;
      finishAllThreadStreams();
      renderBusy();
      const reason = chrome.runtime.lastError?.message || "Native Host 已退出";
      setStatus(`Claude Code 桥接断开：${reason}`);
      scheduleReconnect(`Claude Code 桥接断开：${reason}`);
    });
    state.helloTimer = setTimeout(() => {
      if (!state.connected && attempt === state.connectionAttempt) {
        setStatus("Native Host 已启动但 4 秒未响应 hello · 请运行 Host 自检");
      }
    }, 4000);
    if (!postNative({ type: "hello" })) {
      setStatus("无法向本地 Native Host 发送 hello");
    }
  } catch (error) {
    setStatus(`本地桥接错误：${error.message}`);
    scheduleReconnect(`本地桥接错误：${error.message}`);
  }
}

function handleNativeMessage(message) {
  switch (message.type) {
    case "hello":
      if (state.helloTimer) clearTimeout(state.helloTimer);
      state.helloTimer = null;
      state.connected = true;
      const runtimeLabel = message.runtimeMode === "external-cli" ? "External CLI" : "SDK Built-in";
      const transportLabel = message.transportMode === "detached-daemon" ? " · Detached Daemon" : "";
      const imageLabel = message.imageMode === "safe-text" ? " · 截图安全模式" : " · 原始视觉";
      setStatus(`本地桥接已连接 · ${runtimeLabel}${transportLabel}${imageLabel}${message.hostVersion ? ` · v${message.hostVersion}` : ""}`, true);
      els.reconnectButton.hidden = true;
      clearStableConnectionTimer();
      state.stableConnectionTimer = setTimeout(() => {
        state.disconnectTimes = [];
      }, 30_000);
      renderBusy();
      requestSessions();
      // New sessions use lazy runtime startup. This avoids reconnect loops
      // repeatedly spawning Claude Code before the user sends a message.
      restoreLastSession();
      break;
    case "boot_state":
      setStatus(message.text || "Claude Code 正在初始化…", true);
      break;
    case "boot_warning":
      setStatus(message.text || "Claude Code 环境存在警告");
      break;
    case "boot_error":
      setStatus(message.error || "Claude Code 初始化失败");
      break;
    case "session":
      setCurrentSession(message.sessionId, message.cwd || state.sessionCwd, true);
      break;
    case "session_selected":
      setCurrentSession(message.sessionId, message.cwd || state.sessionCwd, true);
      setStatus("历史会话已恢复 · Persistent Streaming", true);
      break;
    case "session_prepared":
      if (message.capabilitiesStatus === "loaded") {
        setStatus("Claude Code 已就绪 · Commands / Agents 已加载", true);
      } else if (message.capabilitiesStatus === "pending") {
        setStatus("Claude Code 已连接 · Commands / Agents 将在首轮消息后继续加载", true);
      } else {
        setStatus("Claude Code 已连接 · Commands / Agents 加载失败", true);
      }
      break;
    case "session_messages":
      if (message.sessionId !== state.sessionId) break;
      setMainTranscript(message.messages || []);
      break;
    case "sessions":
      state.sessions = message.sessions || [];
      renderHistory();
      break;
    case "capabilities":
      state.commands = message.commands || [];
      state.agents = message.agents || [];
      state.models = message.models || [];
      renderAgents();
      renderModelOptions();
      updateCommandMenu();
      if (!state.busy) setStatus("Claude Code 已就绪 · Persistent Streaming", true);
      break;
    case "capabilities_fallback":
      if (!state.commands.length) state.commands = message.commands || [];
      if (!state.agents.length) state.agents = message.agents || [];
      renderAgents();
      updateCommandMenu();
      break;
    case "capabilities_error":
      setStatus(message.error || "Commands / Agents 加载失败");
      break;
    case "question_request":
      showQuestion(message);
      break;
    case "agent_invoked":
      upsertAgentTask({
        taskId: message.toolUseId || crypto.randomUUID(),
        toolUseId: message.toolUseId || null,
        agentName: message.agentName,
        description: message.description || message.prompt || "Agent 已启动",
        status: "running",
        background: message.background,
      });
      upsertAgentThread({
        threadId: message.threadId || message.toolUseId,
        toolUseId: message.toolUseId || null,
        agentId: message.agentId || null,
        agentName: message.agentName || "subagent",
        description: message.description || message.prompt || "",
        status: "running",
        resumable: Boolean(message.agentId),
      });
      break;
    case "agent_task":
      upsertAgentTask({
        taskId: message.taskId || message.toolUseId || crypto.randomUUID(),
        toolUseId: message.toolUseId || null,
        description: message.description || message.summary || "Agent task",
        status: message.status || (message.subtype === "task_notification" ? "completed" : "running"),
        usage: message.usage || null,
        lastToolName: message.lastToolName || null,
        subtype: message.subtype,
      });
      if (message.toolUseId) {
        const thread = findThreadByToolUseId(message.toolUseId);
        if (thread) upsertAgentThread({ ...thread, status: message.status || thread.status });
      }
      break;
    case "agent_thread":
      upsertAgentThread(message);
      break;
    case "agent_delta":
      upsertAgentThread(message);
      enqueueThreadDelta(message.threadId, message.text || "");
      break;
    case "agent_message":
      upsertAgentThread(message);
      finishThreadStream(message.threadId);
      if (message.text) appendThreadMessage(message.threadId, message.role || "assistant", message.text);
      break;
    case "agent_activity":
      handleAgentActivity(message);
      break;
    case "agent_turn_end":
      upsertAgentThread({ ...message, status: "completed" });
      finishThreadStream(message.threadId);
      break;
    case "queued":
      state.queuedRequestIds.add(message.requestId);
      showActivityText(`消息已排队 · 前面还有 ${message.position || 1} 个任务`);
      renderBusy();
      break;
    case "turn_started":
      state.queuedRequestIds.delete(message.requestId);
      state.busy = true;
      state.requestId = message.requestId;
      finishThreadStream("main");
      // Show the inline working indicator at the answer position immediately so
      // the user can see Claude is engaged during the pre-stream wait.
      showWorkingIndicator("正在处理…");
      if (message.queuedForMs > 150) {
        showActivityText(`开始处理排队消息 · 等待 ${formatDuration(message.queuedForMs)}`);
      } else {
        showActivity("working");
      }
      renderBusy();
      break;
    case "delta":
      if (message.requestId && state.requestId && message.requestId !== state.requestId) break;
      enqueueThreadDelta("main", message.text || "");
      break;
    case "activity":
      if (message.requestId && state.requestId && message.requestId !== state.requestId) break;
      showActivity(message.activity, message.detail || "");
      break;
    case "tool_stream_start":
      if (message.requestId && state.requestId && message.requestId !== state.requestId) break;
      flushThreadStream("main");
      showActivityText(`准备使用 ${prettyToolName(message.name)}…`);
      break;
    case "tool":
      if (message.requestId && state.requestId && message.requestId !== state.requestId) break;
      flushThreadStream("main");
      showActivityText(`正在使用 ${prettyToolName(message.name)}…`);
      break;
    case "tool_progress":
      if (message.requestId && state.requestId && message.requestId !== state.requestId) break;
      showActivityText(`正在使用 ${prettyToolName(message.name)} · ${Math.max(0, Math.round(message.elapsedSeconds || 0))}s`);
      break;
    case "runtime_status":
      if (message.status === "compacting") showActivity("compacting");
      break;
    case "local_output":
      flushThreadStream("main");
      if (message.content) appendThreadMessage("main", "assistant", message.content);
      break;
    case "command_output":
      flushThreadStream("main");
      if (message.text) appendCommandOutput(message.text, { command: message.command, isError: message.isError });
      break;
    case "rate_limit":
      handleRateLimit(message.info || {});
      break;
    case "prompt_suggestion":
      if (message.suggestion && !els.promptInput.value.trim()) {
        els.promptInput.placeholder = message.suggestion;
      }
      break;
    case "permission_request":
      showPermission(message);
      break;
    case "done": {
      if (message.requestId && state.requestId && message.requestId !== state.requestId) break;
      const requestThreadId = state.requestThreads.get(message.requestId) || "main";
      flushThreadStream("main");
      const mainStream = state.threadStreams.get("main");
      if (message.result && (!mainStream?.record || !mainStream.record.text)) {
        appendThreadMessage("main", "assistant", message.result);
      }
      if (message.sessionId) setCurrentSession(message.sessionId, state.sessionCwd, true);
      renderPerformance(message.performance);
      finishTurn(message.requestId);
      if (requestThreadId !== "main") finishThreadStream(requestThreadId);
      requestSessions();
      break;
    }
    case "interrupted": {
      if (message.requestId && state.requestId && message.requestId !== state.requestId) break;
      const requestThreadId = state.requestThreads.get(message.requestId) || "main";
      flushThreadStream("main");
      finishThreadStream(requestThreadId);
      renderPerformance(message.performance);
      finishTurn(message.requestId);
      appendThreadMessage(requestThreadId, "assistant", "已停止。");
      break;
    }
    case "new_session_ready":
      setStatus("正在初始化新的 Claude Code Session…", true);
      prepareSession();
      break;
    case "error":
      if (message.requestId && state.requestId && message.requestId !== state.requestId) {
        state.queuedRequestIds.delete(message.requestId);
        const threadId = state.requestThreads.get(message.requestId) || "main";
        appendThreadMessage(threadId, "error", message.error || "排队任务失败");
        state.requestThreads.delete(message.requestId);
        renderBusy();
        break;
      }
      if (message.requestId || state.busy) {
        const threadId = state.requestThreads.get(message.requestId) || "main";
        flushThreadStream("main");
        finishThreadStream(threadId);
        finishTurn(message.requestId);
        appendThreadMessage(threadId, "error", message.error || "未知的本地桥接错误");
      } else {
        setStatus(message.error || "未知的本地桥接错误");
      }
      break;
  }
}

function prettyToolName(name = "tool") {
  const raw = name.replace(/^mcp__[^_]+__/, "");
  const labels = {
    tabs_context_mcp: "读取浏览器标签页上下文",
    tabs_create_mcp: "新建浏览器标签页",
    navigate: "页面导航",
    computer: "浏览器鼠标与键盘操作",
    read_page: "读取页面结构",
    get_page_text: "读取页面正文",
    find: "查找页面元素",
    form_input: "填写页面表单",
    javascript_tool: "执行页面 JavaScript",
    read_console_messages: "读取控制台日志",
    read_network_requests: "读取网络请求",
    resize_window: "调整浏览器窗口",
    upload_image: "上传图片",
    Read: "读取本地文件",
    Glob: "查找本地文件",
    Grep: "搜索本地代码",
    Write: "写入本地文件",
    Edit: "修改本地文件",
    Bash: "执行终端命令",
    Agent: "启动 Subagent",
    Task: "启动 Subagent",
    AskUserQuestion: "等待用户选择方案",
  };
  return labels[raw] || labels[name] || raw.replaceAll("_", " ");
}

function getThreadMessages(threadId = "main") {
  if (!state.threadMessages.has(threadId)) state.threadMessages.set(threadId, []);
  return state.threadMessages.get(threadId);
}

function createMessageRecord(threadId, role, text = "") {
  const record = { id: crypto.randomUUID(), role, text: String(text || "") };
  const messages = getThreadMessages(threadId);
  messages.push(record);
  if (messages.length > THREAD_MESSAGE_LIMIT) messages.splice(0, messages.length - THREAD_MESSAGE_LIMIT);
  if (threadId !== "main") schedulePersistAgentThreads();
  return record;
}

function copyMessageText(text, button) {
  const value = String(text || "");
  const original = button.textContent;
  const done = () => {
    button.textContent = "已复制";
    button.dataset.copied = "true";
    setTimeout(() => {
      button.textContent = original;
      delete button.dataset.copied;
    }, 1200);
  };

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(value).then(done).catch(() => {});
  }
}

function renderMessageRecord(record, parent = els.messages, options = {}) {
  const row = document.createElement("article");
  row.className = `message ${record.role}`;
  row.dataset.messageId = record.id;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  let textNode = null;
  let streamingView = null;

  // 斜杠命令输出(/cost 等):等宽 + 保留换行的样式块,不走 Markdown(避免换行被吃)。
  if (record.kind === "command_output") {
    row.className = "message assistant";
    bubble.classList.add("message-content");
    const header = document.createElement("div");
    header.className = "command-output-header";
    header.textContent = record.command ? `命令输出 · ${record.command}` : "命令输出";
    const pre = document.createElement("pre");
    pre.className = `command-output${record.isError ? " command-output-error" : ""}`;
    pre.textContent = record.text || "";
    bubble.append(header, pre);
    row.appendChild(bubble);
    parent.appendChild(row);
    return { row, bubble, textNode: null, streamingView: null };
  }

  if (record.role === "assistant") {
    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = "C";

    const column = document.createElement("div");
    column.className = "message-column";
    bubble.classList.add("message-content");

    if (options.streaming) {
      streamingView = ClaudeMarkdown.createStreamingView(bubble, record.text || "");
    } else {
      ClaudeMarkdown.renderInto(bubble, record.text || "");
    }

    const actions = document.createElement("div");
    actions.className = "message-actions";
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "message-action-button";
    copyButton.textContent = "复制";
    copyButton.title = "复制 Claude 回复";
    copyButton.addEventListener("click", () => copyMessageText(record.text, copyButton));
    actions.appendChild(copyButton);

    column.append(bubble, actions);
    row.append(avatar, column);
  } else {
    textNode = document.createTextNode(record.text || "");
    bubble.appendChild(textNode);
    row.appendChild(bubble);
  }

  parent.appendChild(row);
  return { row, bubble, textNode, streamingView };
}

// 命令输出:作为一条 assistant 记录追加,但打 command_output 标 → 渲染成等宽样式块。
function appendCommandOutput(text, meta = {}) {
  const record = createMessageRecord("main", "assistant", text);
  record.kind = "command_output";
  record.command = meta.command || null;
  record.isError = Boolean(meta.isError);
  if (state.activeThreadId === "main") {
    els.emptyState.hidden = true;
    const shouldStick = isNearBottom();
    renderMessageRecord(record);
    if (shouldStick) scheduleScrollToBottom(true);
  }
}

function appendThreadMessage(threadId, role, text) {
  const record = createMessageRecord(threadId, role, text);
  if (threadId === state.activeThreadId) {
    els.emptyState.hidden = true;
    const shouldStick = isNearBottom();
    renderMessageRecord(record);
    if (shouldStick) scheduleScrollToBottom(true);
  } else if (threadId !== "main") {
    const thread = state.agentThreads.get(threadId);
    if (thread) upsertAgentThread({ ...thread, unread: true }, false);
  }
  return record;
}

function clearThreadDom() {
  els.messages.querySelectorAll(".message").forEach((node) => node.remove());
  // The working indicator is a .message row too; drop the stale reference so a
  // later show re-creates it rather than updating a detached node.
  workingIndicatorRow = null;
  for (const stream of state.threadStreams.values()) {
    stream.bubble = null;
    stream.streamingView = null;
  }
}

function renderThread(threadId = state.activeThreadId) {
  clearThreadDom();
  const messages = getThreadMessages(threadId);
  const fragment = document.createDocumentFragment();
  const rendered = new Map();
  const stream = state.threadStreams.get(threadId);
  for (const record of messages) {
    const isStreamingRecord = Boolean(stream?.record && stream.record.id === record.id);
    const elements = renderMessageRecord(record, fragment, { streaming: isStreamingRecord });
    rendered.set(record.id, elements);
  }
  els.messages.appendChild(fragment);

  if (stream?.record) {
    const elements = rendered.get(stream.record.id);
    if (elements) {
      stream.bubble = elements.bubble;
      stream.streamingView = elements.streamingView;
      stream.bubble.classList.add("cursor");
    }
  }

  els.emptyState.hidden = threadId !== "main" || messages.length > 0;
  if (threadId !== "main") {
    const thread = state.agentThreads.get(threadId);
    if (thread?.unread) upsertAgentThread({ ...thread, unread: false }, false);
  }
  renderThreadTabs();
  renderBusy();
  scheduleScrollToBottom(true);
}

function setMainTranscript(messages) {
  const records = (messages || []).map((message) => ({
    id: message.uuid || crypto.randomUUID(),
    role: message.role === "user" ? "user" : "assistant",
    text: message.text || "",
  }));
  state.threadMessages.set("main", records.slice(-THREAD_MESSAGE_LIMIT));
  finishThreadStream("main");
  if (state.activeThreadId === "main") renderThread("main");
}

function getThreadStream(threadId) {
  if (!state.threadStreams.has(threadId)) {
    state.threadStreams.set(threadId, {
      record: null,
      bubble: null,
      streamingView: null,
      pendingText: "",
      renderFrame: null,
      shouldStick: false,
    });
  }
  return state.threadStreams.get(threadId);
}

function ensureThreadStreamRecord(threadId) {
  const stream = getThreadStream(threadId);
  if (!stream.record) stream.record = createMessageRecord(threadId, "assistant", "");
  const willCreateView = threadId === state.activeThreadId && !stream.streamingView;
  if (willCreateView) {
    // Real answer content is starting to render — retire the working indicator.
    if (threadId === "main") hideWorkingIndicator();
    els.emptyState.hidden = true;
    const rendered = renderMessageRecord(stream.record, els.messages, { streaming: true });
    rendered.bubble.classList.add("cursor");
    stream.bubble = rendered.bubble;
    stream.streamingView = rendered.streamingView;
  }
  return stream;
}

function enqueueThreadDelta(threadId, text) {
  if (!threadId || !text) return;
  const stream = ensureThreadStreamRecord(threadId);
  stream.pendingText += text;
  if (threadId === state.activeThreadId) stream.shouldStick ||= isNearBottom();
  if (stream.renderFrame) return;
  stream.renderFrame = requestAnimationFrame(() => flushThreadStream(threadId));
}

function flushThreadStream(threadId) {
  const stream = state.threadStreams.get(threadId);
  if (!stream) return;
  if (stream.renderFrame) {
    cancelAnimationFrame(stream.renderFrame);
    stream.renderFrame = null;
  }
  if (!stream.pendingText) return;
  ensureThreadStreamRecord(threadId);
  const text = stream.pendingText;
  stream.pendingText = "";
  stream.record.text += text;
  if (threadId === state.activeThreadId && stream.streamingView) {
    ClaudeMarkdown.appendStreamingText(stream.streamingView, text);
  }
  if (threadId !== "main") schedulePersistAgentThreads();
  const shouldStick = stream.shouldStick;
  stream.shouldStick = false;
  if (threadId === state.activeThreadId && shouldStick) scheduleScrollToBottom(true);
}

function finishThreadStream(threadId) {
  const stream = state.threadStreams.get(threadId);
  if (!stream) return;
  flushThreadStream(threadId);
  if (stream.bubble) stream.bubble.classList.remove("cursor");
  if (stream.streamingView) ClaudeMarkdown.finishStreamingView(stream.streamingView);
  stream.record = null;
  stream.bubble = null;
  stream.streamingView = null;
  stream.pendingText = "";
  stream.shouldStick = false;
}

function finishAllThreadStreams() {
  for (const threadId of state.threadStreams.keys()) finishThreadStream(threadId);
}

function resetAllThreads() {
  for (const stream of state.threadStreams.values()) {
    if (stream.renderFrame) cancelAnimationFrame(stream.renderFrame);
  }
  state.activeThreadId = "main";
  state.threadMessages = new Map([["main", []]]);
  state.threadStreams = new Map();
  state.agentThreads.clear();
  state.requestThreads.clear();
  clearThreadDom();
  renderThreadTabs();
}

function finishTurn(requestId = null) {
  if (requestId && state.requestId && requestId !== state.requestId) return;
  finishThreadStream("main");
  hideWorkingIndicator();
  if (requestId) state.requestThreads.delete(requestId);
  state.busy = false;
  state.requestId = null;
  els.toolActivity.hidden = true;
  els.toolActivity.textContent = "";
  hidePermission();
  hideQuestion();
  hideCommandMenu();
  renderBusy();
}

function canSendToActiveThread() {
  if (state.activeThreadId === "main") return true;
  return Boolean(state.agentThreads.get(state.activeThreadId)?.agentId);
}

function renderBusy() {
  const canSend = canSendToActiveThread();
  const activeThread = state.agentThreads.get(state.activeThreadId);
  els.sendButton.hidden = false;
  els.stopButton.hidden = !state.busy;
  els.sendButton.disabled = !state.connected || !canSend;
  els.promptInput.disabled = !state.connected || !canSend;
  if (!state.connected) {
    els.promptInput.placeholder = "正在连接本地 Claude Code…";
  } else if (!canSend) {
    els.promptInput.placeholder = `${activeThread?.agentName || "此 Agent"} 是 one-shot，只能查看记录`;
  } else if (state.activeThreadId !== "main") {
    els.promptInput.placeholder = `继续和 ${activeThread?.agentName || "Subagent"} 对话…`;
  } else if (state.busy) {
    els.promptInput.placeholder = "继续输入可排队给 Claude…";
  } else {
    els.promptInput.placeholder = "问 Claude Code 关于当前页面的问题…";
  }
  els.newChatButton.disabled = state.busy || state.queuedRequestIds.size > 0;
  els.historyButton.disabled = state.busy || state.queuedRequestIds.size > 0;
  els.agentsButton.disabled = false;
}

function updatePinnedContextShadow() {
  if (!els.contextStack) return;
  els.contextStack.dataset.scrolled = String(els.messages.scrollTop > 6);
}

function isNearBottom() {
  const remaining = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight;
  return remaining < 120;
}

let scrollFrame = null;
function scheduleScrollToBottom(force = false) {
  if (!force && !isNearBottom()) return;
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    els.messages.scrollTop = els.messages.scrollHeight;
  });
}

function showActivity(activity, detail = "") {
  const labels = {
    thinking: "Claude 正在思考…",
    responding: "Claude 正在回复…",
    preparing_tool: "Claude 正在准备工具调用…",
    compacting: "Claude 正在压缩上下文…",
    working: "Claude 正在处理…",
    agent_working: "Subagent 正在处理…",
  };
  showActivityText(detail ? `${labels[activity] || "Claude 正在处理…"} ${detail}` : (labels[activity] || "Claude 正在处理…"));
}

function showActivityText(text) {
  els.toolActivity.hidden = !text;
  els.toolActivity.textContent = text || "";
  // Mirror the live status into the inline working indicator at the answer
  // position, so the user sees what Claude is doing where the reply will land
  // (not just in the footer strip). Only while the main turn is still pre-stream.
  if (text) {
    const mainStream = state.threadStreams.get("main");
    if (workingIndicatorRow) {
      workingIndicatorRow.__status.textContent = text;
    } else if (state.busy && !mainStream?.streamingView) {
      showWorkingIndicator(text);
    }
  }
}

// --- Inline working indicator (answer position) ---------------------------
// A lightweight assistant bubble mounted at the bottom of the thread while a
// turn is in flight but before any answer tokens render. It mirrors the same
// status text as the footer activity strip and the page-task progress, giving
// the user a visible "Claude is working here" cue during the wait.
let workingIndicatorRow = null;

function showWorkingIndicator(text) {
  els.emptyState.hidden = true;
  if (!workingIndicatorRow) {
    const row = document.createElement("article");
    row.className = "message assistant working";
    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = "C";
    const column = document.createElement("div");
    column.className = "message-column";
    const bubble = document.createElement("div");
    bubble.className = "bubble message-content working-bubble";
    const dots = document.createElement("span");
    dots.className = "working-dots";
    dots.append(
      Object.assign(document.createElement("span"), { className: "working-dot" }),
      Object.assign(document.createElement("span"), { className: "working-dot" }),
      Object.assign(document.createElement("span"), { className: "working-dot" }),
    );
    const status = document.createElement("span");
    status.className = "working-status";
    bubble.append(dots, status);
    column.appendChild(bubble);
    row.append(avatar, column);
    els.messages.appendChild(row);
    row.__status = status;
    workingIndicatorRow = row;
  }
  if (text) workingIndicatorRow.__status.textContent = text;
  scheduleScrollToBottom(true);
}

function hideWorkingIndicator() {
  if (workingIndicatorRow) {
    workingIndicatorRow.remove();
    workingIndicatorRow = null;
  }
}

// Bridge so other extension modules (e.g. the page-task progress bar) can push
// live status into the inline indicator at the answer position.
globalThis.__claudeSidebarActivity = (text) => {
  if (typeof text === "string" && text) showActivityText(text);
};

function handleRateLimit(info) {
  if (info.status === "rejected") {
    const reset = info.resetsAt ? new Date(info.resetsAt).toLocaleTimeString() : "";
    setStatus(`Claude 限流${reset ? ` · ${reset} 后恢复` : ""}`);
    return;
  }
  if (info.status === "allowed_warning") {
    const utilization = Number.isFinite(info.utilization) ? ` · ${Math.round(info.utilization * 100)}%` : "";
    showActivityText(`Claude 使用额度接近限制${utilization}`);
  }
}


function findThreadByToolUseId(toolUseId) {
  return [...state.agentThreads.values()].find((thread) => thread.toolUseId === toolUseId) || null;
}

function upsertAgentThread(update, persist = true) {
  const threadId = update?.threadId || update?.toolUseId;
  if (!threadId) return null;
  const previous = state.agentThreads.get(threadId) || {
    threadId,
    toolUseId: null,
    agentId: null,
    agentName: "subagent",
    description: "",
    status: "running",
    resumable: false,
    unread: false,
  };
  const patch = {};
  for (const key of ["toolUseId", "agentId", "agentName", "description", "status", "unread"]) {
    if (update[key] !== undefined) patch[key] = update[key];
  }
  const thread = { ...previous, ...patch, threadId };
  thread.agentId = thread.agentId || previous.agentId || null;
  thread.agentName = thread.agentName || previous.agentName || "subagent";
  thread.resumable = Boolean(thread.agentId);

  const changed = ["toolUseId", "agentId", "agentName", "description", "status", "resumable", "unread"]
    .some((key) => previous[key] !== thread[key]);
  state.agentThreads.set(threadId, thread);
  getThreadMessages(threadId);
  if (changed) {
    renderThreadTabs();
    if (persist) schedulePersistAgentThreads();
  }
  return thread;
}

function renderThreadTabs() {
  els.threadBar.hidden = state.agentThreads.size === 0;
  els.mainThreadButton.dataset.active = String(state.activeThreadId === "main");
  els.threadTabs.textContent = "";
  for (const thread of state.agentThreads.values()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thread-tab";
    button.dataset.threadId = thread.threadId;
    button.dataset.active = String(state.activeThreadId === thread.threadId);
    button.dataset.status = thread.status || "running";
    button.dataset.resumable = String(Boolean(thread.agentId));
    button.dataset.unread = String(Boolean(thread.unread));
    button.textContent = thread.agentName || "Subagent";
    button.title = [
      thread.agentName || "Subagent",
      thread.description || "",
      thread.agentId ? `agentId: ${thread.agentId}` : "one-shot / agentId 尚不可用",
    ].filter(Boolean).join("\n");
    button.addEventListener("click", () => setActiveThread(thread.threadId));
    els.threadTabs.appendChild(button);
  }
}

function setActiveThread(threadId) {
  if (threadId !== "main" && !state.agentThreads.has(threadId)) return;
  state.activeThreadId = threadId;
  const thread = state.agentThreads.get(threadId);
  if (thread?.unread) {
    thread.unread = false;
    state.agentThreads.set(threadId, thread);
    schedulePersistAgentThreads();
  }
  renderThread(threadId);
}

function handleAgentActivity(message) {
  const thread = upsertAgentThread({
    ...message,
    status: message.activity === "tool" || message.activity === "thinking" || message.activity === "preparing_tool" ? "running" : undefined,
  });
  if (!thread) return;
  if (state.activeThreadId === thread.threadId) {
    if (message.activity === "tool") {
      showActivityText(`${thread.agentName} 正在使用 ${prettyToolName(message.name)}${message.elapsedSeconds ? ` · ${Math.round(message.elapsedSeconds)}s` : ""}`);
    } else if (message.activity === "thinking") {
      showActivityText(`${thread.agentName} 正在思考…`);
    } else if (message.activity === "preparing_tool") {
      showActivityText(`${thread.agentName} 正在准备工具调用…`);
    }
  }
}

function serializeAgentThreads() {
  const threads = [...state.agentThreads.values()].slice(-30).map((thread) => ({
    threadId: thread.threadId,
    toolUseId: thread.toolUseId || null,
    agentId: thread.agentId || null,
    agentName: thread.agentName || "subagent",
    description: thread.description || "",
    status: thread.status || "completed",
    resumable: Boolean(thread.agentId),
    unread: false,
  }));
  const messages = {};
  for (const thread of threads) {
    messages[thread.threadId] = getThreadMessages(thread.threadId)
      .slice(-THREAD_MESSAGE_LIMIT)
      .map((record) => ({
        id: record.id,
        role: record.role,
        text: String(record.text || "").slice(-THREAD_TEXT_LIMIT),
      }));
  }
  return { savedAt: Date.now(), activeThreadId: state.activeThreadId, threads, messages };
}

function persistAgentThreadsNow(sessionId = state.sessionId) {
  if (!sessionId || state.sessionId !== sessionId) return;
  if (state.threadPersistTimer) {
    clearTimeout(state.threadPersistTimer);
    state.threadPersistTimer = null;
  }
  state.savedThreadStore[sessionId] = serializeAgentThreads();
  const entries = Object.entries(state.savedThreadStore)
    .sort((a, b) => Number(b[1]?.savedAt || 0) - Number(a[1]?.savedAt || 0))
    .slice(0, 40);
  state.savedThreadStore = Object.fromEntries(entries);
  void chrome.storage.local.set({ [THREAD_STORAGE_KEY]: state.savedThreadStore }).catch((error) => {
    console.warn("Failed to persist Agent Threads", error);
  });
}

function schedulePersistAgentThreads() {
  const sessionId = state.sessionId;
  if (!sessionId || state.threadPersistTimer) return;
  state.threadPersistTimer = setTimeout(() => {
    state.threadPersistTimer = null;
    if (state.sessionId === sessionId) persistAgentThreadsNow(sessionId);
  }, 500);
}

function restoreAgentThreadsForSession(sessionId) {
  const mainMessages = getThreadMessages("main");
  for (const stream of state.threadStreams.values()) {
    if (stream.renderFrame) cancelAnimationFrame(stream.renderFrame);
  }
  state.threadMessages = new Map([["main", mainMessages]]);
  state.threadStreams = new Map();
  state.agentThreads.clear();
  const saved = state.savedThreadStore?.[sessionId];
  if (saved) {
    for (const thread of saved.threads || []) {
      state.agentThreads.set(thread.threadId, { ...thread, unread: false });
      const records = (saved.messages?.[thread.threadId] || []).map((record) => ({
        id: record.id || crypto.randomUUID(),
        role: record.role || "assistant",
        text: record.text || "",
      }));
      state.threadMessages.set(thread.threadId, records);
    }
    state.activeThreadId = saved.activeThreadId === "main" || state.agentThreads.has(saved.activeThreadId)
      ? saved.activeThreadId
      : "main";
  } else {
    state.activeThreadId = "main";
  }
  renderThreadTabs();
}


async function adoptCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  state.currentPage = { tabId: tab.id, title: tab.title || "无标题页面", url: tab.url || "" };
  els.pageTitle.textContent = state.currentPage.title;
  els.pageUrl.textContent = state.currentPage.url;
  els.pageContext.hidden = !state.settings.includePageContext;
  try {
    await chrome.runtime.sendMessage({ type: "sidebar_adopt_tab", tabId: tab.id });
  } catch {}
  return state.currentPage;
}

async function sendPrompt(rawPrompt) {
  const prompt = rawPrompt.trim();
  if (!prompt || !state.port || !state.connected) return;

  const threadId = state.activeThreadId;
  const thread = threadId === "main" ? null : state.agentThreads.get(threadId);
  if (threadId !== "main" && !thread?.agentId) {
    appendThreadMessage(threadId, "error", `${thread?.agentName || "此 Agent"} 是 one-shot Agent，或尚未返回 agentId；当前只能查看记录，不能续接上下文。`);
    renderBusy();
    return;
  }

  const pageContext = state.settings.includePageContext ? await adoptCurrentTab() : null;
  const requestId = crypto.randomUUID();
  state.requestThreads.set(requestId, threadId);
  appendThreadMessage(threadId, "user", prompt);

  if (!state.busy) {
    state.busy = true;
    state.requestId = requestId;
    finishThreadStream("main");
    if (threadId !== "main") finishThreadStream(threadId);
  } else {
    state.queuedRequestIds.add(requestId);
  }

  renderBusy();
  els.promptInput.value = "";
  autosize();
  els.performanceBar.hidden = true;

  postNative({
    type: "chat",
    requestId,
    prompt,
    sessionId: state.sessionId,
    pageContext,
    thread: thread ? {
      threadId: thread.threadId,
      agentId: thread.agentId,
      agentName: thread.agentName,
    } : null,
    cwd: activeCwd(),
    model: state.settings.model || undefined,
    permissionMode: state.settings.permissionMode,
  });
}

function showPermission(message) {
  state.currentPermission = message;
  els.permissionTool.textContent = prettyToolName(message.toolName);
  els.permissionInput.textContent = JSON.stringify(message.input || {}, null, 2);
  els.permissionPanel.hidden = false;
}

function hidePermission() {
  state.currentPermission = null;
  els.permissionPanel.hidden = true;
}

function hideQuestion() {
  state.currentQuestion = null;
  els.questionPanel.hidden = true;
  els.questionList.textContent = "";
}

function answerPermission(allow) {
  if (!state.currentPermission || !state.port) return;
  postNative({
    type: "permission_response",
    permissionId: state.currentPermission.permissionId,
    allow,
  });
  hidePermission();
}

function showQuestion(message) {
  state.currentQuestion = {
    questionId: message.questionId,
    questions: message.questions || [],
    answers: new Map(),
  };
  els.questionList.textContent = "";

  for (const [questionIndex, question] of state.currentQuestion.questions.entries()) {
    const card = document.createElement("div");
    card.className = "question-card";

    const header = document.createElement("div");
    header.className = "question-header";
    header.textContent = question.header || `问题 ${questionIndex + 1}`;

    const title = document.createElement("div");
    title.className = "question-text";
    title.textContent = question.question || "请选择";

    const options = document.createElement("div");
    options.className = "question-options";
    const selected = new Set();
    state.currentQuestion.answers.set(question.question, selected);

    for (const option of question.options || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "question-option";
      button.dataset.selected = "false";

      const label = document.createElement("strong");
      label.textContent = option.label || "选项";
      const description = document.createElement("span");
      description.textContent = option.description || "";
      button.append(label, description);

      if (option.preview) {
        const preview = document.createElement("div");
        preview.className = "question-preview";
        ClaudeMarkdown.renderInto(preview, option.preview);
        button.appendChild(preview);
      }

      button.addEventListener("click", () => {
        if (!question.multiSelect) {
          selected.clear();
          options.querySelectorAll(".question-option").forEach((node) => { node.dataset.selected = "false"; });
        }
        if (selected.has(option.label)) {
          selected.delete(option.label);
          button.dataset.selected = "false";
        } else {
          selected.add(option.label);
          button.dataset.selected = "true";
        }
        updateQuestionSubmitState();
      });
      options.appendChild(button);
    }

    const other = document.createElement("input");
    other.className = "question-other";
    other.placeholder = "其他答案（可选）";
    other.addEventListener("input", () => {
      const value = other.value.trim();
      if (value) state.currentQuestion.answers.set(`${question.question}::custom`, value);
      else state.currentQuestion.answers.delete(`${question.question}::custom`);
      updateQuestionSubmitState();
    });

    card.append(header, title, options, other);
    els.questionList.appendChild(card);
  }

  els.questionPanel.hidden = false;
  updateQuestionSubmitState();
}

function updateQuestionSubmitState() {
  if (!state.currentQuestion) {
    els.submitQuestion.disabled = true;
    return;
  }
  els.submitQuestion.disabled = state.currentQuestion.questions.some((question) => {
    const selected = state.currentQuestion.answers.get(question.question);
    const custom = state.currentQuestion.answers.get(`${question.question}::custom`);
    return (!selected || selected.size === 0) && !custom;
  });
}

function submitQuestionAnswers() {
  if (!state.currentQuestion || els.submitQuestion.disabled) return;
  const answers = {};
  for (const question of state.currentQuestion.questions) {
    const custom = state.currentQuestion.answers.get(`${question.question}::custom`);
    const selected = state.currentQuestion.answers.get(question.question) || new Set();
    if (custom) answers[question.question] = custom;
    else if (question.multiSelect) answers[question.question] = [...selected];
    else answers[question.question] = [...selected][0] || "";
  }
  postNative({
    type: "question_response",
    questionId: state.currentQuestion.questionId,
    answers,
  });
  hideQuestion();
}

function commandQuery() {
  const value = els.promptInput.value;
  if (!value.startsWith("/")) return null;
  const firstLine = value.split("\n", 1)[0];
  if (/\s/.test(firstLine.slice(1))) return null;
  return firstLine.slice(1).toLowerCase();
}

// 内置合成命令:不随 capabilities(system/init 的 slash_commands)一起下发的命令。
// 包含本扩展自建的 /qa,以及 Claude Code 的内置 CLI 命令(/cost 等,不在 slash_commands 里)。
// 注入斜杠菜单让其可被发现;即使 Claude Code 尚未启动也照常显示。
const BUILTIN_COMMANDS = [
  { name: "qa", argumentHint: "<PRD链接> [被测页URL]", description: "飞书 PRD 自动化测试:读需求→生成脚本→人审→重放→结果播报" },
  { name: "cost", description: "显示本次会话的 token 用量与花费" },
  { name: "context", description: "查看当前上下文占用明细" },
  { name: "status", description: "查看 Claude Code 运行状态" },
  { name: "model", argumentHint: "[模型名]", description: "查看或切换模型" },
  { name: "config", description: "查看 / 修改配置" },
  { name: "compact", description: "压缩当前会话上下文" },
  { name: "clear", description: "清空当前会话" },
  { name: "agents", description: "查看可用子代理" },
  { name: "resume", description: "恢复历史会话" },
  { name: "help", description: "查看可用命令帮助" },
];

function updateCommandMenu() {
  const query = commandQuery();
  if (query == null) {
    hideCommandMenu();
    return;
  }
  // 原生命令未加载 → 后台拉起 Claude Code 读取;内置命令不受影响,继续往下渲染。
  if (!state.commands.length && state.connected && !state.busy) {
    setStatus("正在启动 Claude Code 并读取 Commands…", true);
    prepareSession();
  }
  // 内置命令 + capabilities 命令,按 name 去重(内置优先),再按输入过滤。
  const byName = new Map();
  for (const command of [...BUILTIN_COMMANDS, ...state.commands]) {
    const name = String(command.name || "").toLowerCase();
    if (name && !byName.has(name)) byName.set(name, command);
  }
  const matches = [...byName.values()]
    .filter((command) => String(command.name || "").toLowerCase().includes(query))
    .slice(0, 12);
  if (!matches.length) {
    hideCommandMenu();
    return;
  }

  els.commandMenu.textContent = "";
  for (const command of matches) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "command-item";
    const commandName = document.createElement("strong");
    commandName.textContent = `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
    const description = document.createElement("span");
    description.textContent = command.description || "Claude Code command";
    button.append(commandName, description);
    button.addEventListener("click", () => selectCommand(command));
    els.commandMenu.appendChild(button);
  }
  els.commandMenu.hidden = false;
}

function selectCommand(command) {
  els.promptInput.value = `/${command.name}${command.argumentHint ? " " : ""}`;
  els.promptInput.focus();
  autosize();
  hideCommandMenu();
}

function hideCommandMenu() {
  els.commandMenu.hidden = true;
}

function renderModelOptions() {
  els.modelOptions.textContent = "";
  for (const model of state.models) {
    const option = document.createElement("option");
    option.value = model.value || "";
    option.label = model.displayName || model.value || "";
    els.modelOptions.appendChild(option);
  }
}

function renderAgents() {
  if (!state.agents.length) {
    els.agentsList.innerHTML = '<div class="history-empty">当前 Session 没有发现可用 Agent</div>';
    return;
  }
  els.agentsList.textContent = "";
  for (const agent of state.agents) {
    const button = document.createElement("button");
    button.className = "agent-item";
    const top = document.createElement("div");
    top.className = "agent-item-top";
    const name = document.createElement("strong");
    name.textContent = agent.name || "Agent";
    const model = document.createElement("span");
    model.textContent = agent.model || "inherit";
    top.append(name, model);
    const description = document.createElement("div");
    description.className = "agent-description";
    description.textContent = agent.description || "Claude Code Subagent";
    button.append(top, description);
    button.addEventListener("click", () => {
      els.promptInput.value = `使用 ${agent.name} Agent 完成：`;
      els.promptInput.focus();
      autosize();
      closeAgents();
    });
    els.agentsList.appendChild(button);
  }
}

function openAgents() {
  els.agentsBackdrop.hidden = false;
  els.agentsDrawer.hidden = false;
  if (!state.agents.length && state.connected && !state.busy) {
    els.agentsList.innerHTML = '<div class="history-loading">正在启动 Claude Code 并读取 Agents…</div>';
    prepareSession();
    return;
  }
  renderAgents();
}

function closeAgents() {
  els.agentsBackdrop.hidden = true;
  els.agentsDrawer.hidden = true;
}

function upsertAgentTask(update) {
  const taskId = update.taskId;
  let previousKey = taskId;
  if (update.toolUseId && !state.agentTasks.has(taskId)) {
    const match = [...state.agentTasks.entries()].find(([key, task]) => key === update.toolUseId || task.toolUseId === update.toolUseId);
    if (match) previousKey = match[0];
  }
  const previous = state.agentTasks.get(previousKey) || {};
  if (previousKey !== taskId) state.agentTasks.delete(previousKey);
  state.agentTasks.set(taskId, { ...previous, ...update, taskId });
  renderAgentTasks();
}

function renderAgentTasks() {
  const tasks = [...state.agentTasks.values()].slice(-5);
  if (!tasks.length) {
    els.agentActivityList.hidden = true;
    els.agentActivityList.textContent = "";
    return;
  }
  els.agentActivityList.textContent = "";
  for (const task of tasks) {
    const card = document.createElement("div");
    card.className = "agent-task";
    card.dataset.status = task.status || "running";
    const name = document.createElement("strong");
    name.textContent = task.agentName || task.description || "Subagent";
    const meta = document.createElement("span");
    const status = task.status === "completed" ? "完成" : task.status === "failed" ? "失败" : task.status === "stopped" ? "停止" : "运行中";
    const tokens = task.usage?.total_tokens ? ` · ${formatTokens(task.usage.total_tokens)} tok` : "";
    const tool = task.lastToolName ? ` · ${prettyToolName(task.lastToolName)}` : "";
    meta.textContent = `${status}${tokens}${tool}`;
    card.append(name, meta);
    els.agentActivityList.appendChild(card);
  }
  els.agentActivityList.hidden = false;
}

function autosize() {
  els.promptInput.style.height = "auto";
  els.promptInput.style.height = `${Math.min(160, els.promptInput.scrollHeight)}px`;
}

function formatDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function formatTokens(value) {
  const number = Number(value || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return String(number);
}

function renderPerformance(performance) {
  if (!performance) {
    els.performanceBar.hidden = true;
    return;
  }

  const cacheRate = performance.cacheHitRate == null
    ? null
    : Math.round(performance.cacheHitRate * 100);
  const parts = [
    `Feedback ${formatDuration(performance.firstFeedbackMs)}`,
    `TTFT ${formatDuration(performance.ttftMs)}`,
    `Total ${formatDuration(performance.totalMs)}`,
    `Cache ${cacheRate == null ? "—" : `${cacheRate}%`}`,
    `Read ${formatTokens(performance.cacheReadInputTokens)}`,
    `Fresh ${formatTokens(performance.inputTokens)}`,
  ];
  els.performanceBar.textContent = parts.join(" · ");
  els.performanceBar.hidden = false;
  els.performanceBar.dataset.cache = cacheRate == null ? "" : cacheRate >= 70 ? "good" : cacheRate < 30 ? "bad" : "";
  els.performanceBar.title = [
    `首个可见反馈: ${formatDuration(performance.firstFeedbackMs)}`,
    `首 Token: ${formatDuration(performance.ttftMs)}`,
    `总耗时: ${formatDuration(performance.totalMs)}`,
    `API 耗时: ${formatDuration(performance.apiDurationMs)}`,
    `缓存命中率: ${cacheRate == null ? "无法计算" : `${cacheRate}%`}`,
    `Cache Read: ${performance.cacheReadInputTokens || 0}`,
    `Cache Create: ${performance.cacheCreationInputTokens || 0}`,
    `Fresh Input: ${performance.inputTokens || 0}`,
    `Output: ${performance.outputTokens || 0}`,
    `Native delta batches: ${performance.nativeDeltaMessages || 0}`,
  ].join("\n");
}

async function loadSettings() {
  const saved = await chrome.storage.local.get(["claudeSidebarSettings", "claudeSidebarLastSession", THREAD_STORAGE_KEY]);
  state.settings = { ...state.settings, ...(saved.claudeSidebarSettings || {}) };
  state.lastSession = saved.claudeSidebarLastSession || null;
  state.savedThreadStore = saved[THREAD_STORAGE_KEY] || {};
  els.cwdInput.value = state.settings.cwd;
  els.modelInput.value = state.settings.model;
  els.permissionModeInput.value = state.settings.permissionMode;
  els.includePageContextInput.checked = state.settings.includePageContext;
}

async function saveSettings() {
  state.settings = {
    cwd: els.cwdInput.value.trim(),
    model: els.modelInput.value.trim(),
    permissionMode: els.permissionModeInput.value,
    includePageContext: els.includePageContextInput.checked,
  };
  await chrome.storage.local.set({ claudeSidebarSettings: state.settings });
  els.pageContext.hidden = !state.settings.includePageContext;
  requestSessions();
}

async function persistCurrentSession() {
  if (!state.sessionId) return;
  state.lastSession = { sessionId: state.sessionId, cwd: state.sessionCwd || null };
  await chrome.storage.local.set({ claudeSidebarLastSession: state.lastSession });
}

function setCurrentSession(sessionId, cwd = null, persist = false) {
  if (!sessionId) return;
  state.sessionId = sessionId;
  if (cwd) state.sessionCwd = cwd;
  els.sessionLabel.textContent = `会话 ${sessionId.slice(0, 8)}${state.sessionCwd ? ` · ${basename(state.sessionCwd)}` : ""}`;
  if (persist) void persistCurrentSession();
  if (state.agentThreads.size) schedulePersistAgentThreads();
  renderHistory();
}

function basename(value) {
  if (!value) return "";
  const parts = value.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) || value;
}

function prepareSession() {
  if (!state.connected) return;
  postNative({
    type: "prepare_session",
    sessionId: state.sessionId,
    cwd: activeCwd(),
    model: state.settings.model || undefined,
    permissionMode: state.settings.permissionMode,
  });
}

function requestSessions() {
  if (!state.connected) return;
  postNative({
    type: "list_sessions",
    cwd: state.settings.cwd || undefined,
  });
}

function sessionGroup(lastModified) {
  const date = new Date(lastModified);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDiff = Math.round((today - target) / 86_400_000);
  if (dayDiff === 0) return "今天";
  if (dayDiff === 1) return "昨天";
  if (dayDiff < 7) return "最近 7 天";
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return "本月";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function formatSessionTime(lastModified) {
  const date = new Date(lastModified);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "2-digit", day: "2-digit" });
}

function renderHistory() {
  if (!state.sessions.length) {
    els.historyList.innerHTML = '<div class="history-empty">没有找到 Claude Code 历史会话</div>';
    return;
  }

  els.historyList.textContent = "";
  let currentGroup = null;
  for (const session of state.sessions) {
    const group = sessionGroup(session.lastModified);
    if (group !== currentGroup) {
      currentGroup = group;
      const heading = document.createElement("div");
      heading.className = "history-group";
      heading.textContent = group;
      els.historyList.appendChild(heading);
    }

    const button = document.createElement("button");
    button.className = "history-item";
    button.dataset.active = String(session.sessionId === state.sessionId);

    const title = document.createElement("div");
    title.className = "history-title";
    title.textContent = session.summary || "未命名会话";

    const meta = document.createElement("div");
    meta.className = "history-meta";
    const cwd = document.createElement("span");
    cwd.className = "history-cwd";
    cwd.textContent = session.cwd ? basename(session.cwd) : "Claude Code";
    cwd.title = session.cwd || "";
    const time = document.createElement("span");
    time.textContent = formatSessionTime(session.lastModified);
    meta.append(cwd, time);

    button.append(title, meta);
    button.addEventListener("click", () => openSession(session));
    els.historyList.appendChild(button);
  }
}

function openHistory() {
  if (state.busy) return;
  els.historyBackdrop.hidden = false;
  els.historyDrawer.hidden = false;
  requestSessions();
}

function closeHistory() {
  els.historyBackdrop.hidden = true;
  els.historyDrawer.hidden = true;
}

function openSession(session, closeDrawer = true) {
  if (!session?.sessionId || state.busy || !state.connected) return;
  persistAgentThreadsNow();
  state.sessionId = session.sessionId;
  state.sessionCwd = session.cwd || null;
  els.sessionLabel.textContent = `会话 ${session.sessionId.slice(0, 8)}${state.sessionCwd ? ` · ${basename(state.sessionCwd)}` : ""}`;
  resetAllThreads();
  restoreAgentThreadsForSession(session.sessionId);
  renderThread(state.activeThreadId);
  els.emptyState.hidden = true;
  els.performanceBar.hidden = true;
  setStatus("正在读取并恢复历史会话…", true);

  postNative({
    type: "get_session_messages",
    sessionId: session.sessionId,
    cwd: session.cwd || undefined,
  });
  postNative({
    type: "select_session",
    sessionId: session.sessionId,
    cwd: session.cwd || undefined,
    model: state.settings.model || undefined,
    permissionMode: state.settings.permissionMode,
  });
  void persistCurrentSession();
  renderHistory();
  if (closeDrawer) closeHistory();
}

function restoreLastSession() {
  if (state.restoredLastSession || !state.lastSession?.sessionId) return false;
  state.restoredLastSession = true;
  openSession({
    sessionId: state.lastSession.sessionId,
    cwd: state.lastSession.cwd || undefined,
  }, false);
  return true;
}

async function newChat() {
  if (state.busy) return;
  persistAgentThreadsNow();
  state.sessionId = null;
  state.sessionCwd = null;
  state.lastSession = null;
  state.commands = [];
  state.agents = [];
  state.agentTasks.clear();
  state.queuedRequestIds.clear();
  resetAllThreads();
  state.currentQuestion = null;
  els.questionPanel.hidden = true;
  renderAgentTasks();
  renderAgents();
  hideCommandMenu();
  await chrome.storage.local.remove("claudeSidebarLastSession");
  els.sessionLabel.textContent = "新的本地会话";
  renderThread("main");
  els.emptyState.hidden = false;
  els.performanceBar.hidden = true;
  postNative({ type: "new_session" });
  renderHistory();
  closeHistory();
}

els.mainThreadButton.addEventListener("click", () => setActiveThread("main"));
els.messages.addEventListener("scroll", updatePinnedContextShadow, { passive: true });
els.reconnectButton.addEventListener("click", () => {
  resetReconnectBreaker();
  connect();
});
els.sendButton.addEventListener("click", () => sendPrompt(els.promptInput.value));
els.stopButton.addEventListener("click", () => {
  if (state.port && state.requestId) postNative({ type: "interrupt", requestId: state.requestId });
});
els.promptInput.addEventListener("input", () => {
  autosize();
  updateCommandMenu();
});

// IME composition guard: selecting Chinese/Japanese/Korean candidates often uses Enter.
// Key events are still dispatched while composition is active, so Enter must not send.
let promptIsComposing = false;

els.promptInput.addEventListener("compositionstart", () => {
  promptIsComposing = true;
});

els.promptInput.addEventListener("compositionend", () => {
  promptIsComposing = false;
});

els.promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideCommandMenu();

  const isImeComposing =
    promptIsComposing ||
    event.isComposing ||
    event.keyCode === 229;

  if (event.key === "Enter" && !event.shiftKey && !isImeComposing) {
    event.preventDefault();
    sendPrompt(els.promptInput.value);
  }
});
els.newChatButton.addEventListener("click", newChat);
els.historyNewChatButton.addEventListener("click", newChat);
els.agentsButton.addEventListener("click", openAgents);
els.closeAgentsButton.addEventListener("click", closeAgents);
els.agentsBackdrop.addEventListener("click", closeAgents);
els.historyButton.addEventListener("click", openHistory);
els.closeHistoryButton.addEventListener("click", closeHistory);
els.historyBackdrop.addEventListener("click", closeHistory);
els.settingsButton.addEventListener("click", () => els.settingsDialog.showModal());
els.saveSettingsButton.addEventListener("click", saveSettings);
els.allowPermission.addEventListener("click", () => answerPermission(true));
els.denyPermission.addEventListener("click", () => answerPermission(false));
els.submitQuestion.addEventListener("click", submitQuestionAnswers);
document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => sendPrompt(button.dataset.prompt));
});

chrome.tabs.onActivated.addListener(adoptCurrentTab);
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tab.active && (info.url || info.title || info.status === "complete")) adoptCurrentTab();
});

(async () => {
  await loadSettings();
  await adoptCurrentTab();
  connect();
  renderBusy();
  autosize();
})();
