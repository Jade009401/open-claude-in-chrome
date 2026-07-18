#!/usr/bin/env bash
# ============================================================================
# open-claude-in-chrome 统一安装器
#   同时安装:① 侧栏 chat daemon(com.anthropic.claude_sidebar_chat)
#            ② 浏览器自动化 host(com.anthropic.open_claude_in_chrome,18 工具)
#
# 设计:run-from-clone —— daemon / relay / mcp 全部直接从本 clone 的 host/ 运行,
#       不再暂存到 Application Support,消除多副本漂移。仓库即运行的代码。
#
# 用法:./install.sh <扩展id> [更多扩展id ...]
#   扩展 id:在 chrome://extensions 开发者模式加载 extension/ 后,复制其 id
# ============================================================================
set -euo pipefail

# ---- 0. 参数 --------------------------------------------------------------
if [[ $# -lt 1 ]]; then
  echo "用法: $0 <扩展id> [更多扩展id ...]"
  echo "  先在 chrome://extensions 开启开发者模式、加载 extension/ 目录,再复制扩展 id 传入。"
  exit 1
fi
EXT_IDS=("$@")

# ---- 1. 路径与依赖 --------------------------------------------------------
HOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/host" && pwd)"   # <clone>/host
REPO_DIR="$(cd "$HOST_DIR/.." && pwd)"                          # <clone>
NODE_BIN="$(command -v node || true)"
CLAUDE_BIN="$(command -v claude || true)"

[[ -z "$NODE_BIN" ]] && { echo "错误:未找到 node,请先安装 Node.js ≥ 20"; exit 1; }
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -lt 20 ]] && { echo "错误:需要 Node ≥ 20(当前 $("$NODE_BIN" -v))"; exit 1; }
[[ -z "$CLAUDE_BIN" ]] && echo "警告:未找到 claude CLI —— 侧栏 daemon 与浏览器自动化 MCP 都需要它。"

# ---- 2. host 依赖(含 Agent SDK) -----------------------------------------
if [[ ! -d "$HOST_DIR/node_modules/@anthropic-ai/claude-agent-sdk" ]]; then
  echo "安装 host 依赖(npm install)..."
  ( cd "$HOST_DIR" && npm install )
fi

# ---- 3. 运行期目录 / socket(只放日志和生成物,不放代码) ------------------
RUNTIME_ROOT="$HOME/Library/Application Support/ClaudeSidebarHost"
mkdir -p "$RUNTIME_ROOT"
DAEMON_SOCKET="/tmp/claude-sidebar-daemon-$(id -u).sock"
RELAY_WRAPPER="$RUNTIME_ROOT/chat-native-relay-wrapper.sh"
AUTO_WRAPPER="$RUNTIME_ROOT/native-host-wrapper.sh"
RELAY_LOG="$RUNTIME_ROOT/native-relay.log"
DAEMON_LOG="$RUNTIME_ROOT/daemon.log"
CONTEXT_FILE="$RUNTIME_ROOT/browser-context.json"

# ---- 4. 生成 relay wrapper(Chrome 通过它连 daemon,直接跑 clone 里的 relay) --
cat > "$RELAY_WRAPPER" <<EOF
#!/usr/bin/env bash
# 由 install.sh 生成:Chrome native messaging 入口,转发到常驻 daemon 的 socket。
export CLAUDE_SIDEBAR_DAEMON_SOCKET="$DAEMON_SOCKET"
exec "$NODE_BIN" "$HOST_DIR/chat-native-relay.js" 2>>"$RELAY_LOG"
EOF
chmod +x "$RELAY_WRAPPER"

# ---- 5. 生成浏览器自动化 wrapper(native-host.js,直接跑 clone) ------------
cat > "$AUTO_WRAPPER" <<EOF
#!/bin/sh
# 由 install.sh 生成:浏览器自动化 native host。
exec "$NODE_BIN" "$HOST_DIR/native-host.js"
EOF
chmod +x "$AUTO_WRAPPER"

# ---- 6. 写 native messaging manifest(两个 host × 已安装的浏览器) ---------
ORIGINS=""
for id in "${EXT_IDS[@]}"; do
  [[ -n "$ORIGINS" ]] && ORIGINS+=", "
  ORIGINS+="\"chrome-extension://$id/\""
done

# 写单个 manifest:$1=host名 $2=可执行路径 $3=浏览器 NativeMessagingHosts 目录
write_manifest() {
  local name="$1" bin="$2" dir="$3"
  [[ -d "$(dirname "$dir")" ]] || return 0   # 该浏览器未安装则跳过
  mkdir -p "$dir"
  cat > "$dir/$name.json" <<EOF
{
  "name": "$name",
  "description": "open-claude-in-chrome native host",
  "path": "$bin",
  "type": "stdio",
  "allowed_origins": [$ORIGINS]
}
EOF
  echo "  已注册 $name -> $dir"
}

# 覆盖常见 Chromium 浏览器(不存在的自动跳过)
declare -a NMH_DIRS=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
)
echo "注册 native messaging host(扩展 id: ${EXT_IDS[*]})..."
for d in "${NMH_DIRS[@]}"; do
  write_manifest "com.anthropic.claude_sidebar_chat" "$RELAY_WRAPPER" "$d"      # 侧栏 daemon
  write_manifest "com.anthropic.open_claude_in_chrome" "$AUTO_WRAPPER" "$d"     # 浏览器自动化
done

# ---- 7. launchd LaunchAgent:侧栏 daemon 开机自启 + 崩溃自愈 ----------------
PLIST_LABEL="com.openclaude.sidebar-daemon"
PLIST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"

# 先卸下旧的 daemon(历史遗留 sunny 版 + 本 label),并停用旧 sunny plist 文件
for old_label in com.sunny.claude-sidebar-daemon "$PLIST_LABEL"; do
  launchctl bootout "gui/$(id -u)/$old_label" 2>/dev/null || true
done
OLD_SUNNY="$HOME/Library/LaunchAgents/com.sunny.claude-sidebar-daemon.plist"
[[ -f "$OLD_SUNNY" ]] && mv "$OLD_SUNNY" "$OLD_SUNNY.disabled"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$HOST_DIR/chat-native-host.js</string>
    <string>--daemon</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_SIDEBAR_RUNTIME</key><string>sdk-builtin</string>
    <key>CLAUDE_SIDEBAR_IMAGE_MODE</key><string>mcp-image</string>
    <key>CLAUDE_SIDEBAR_DAEMON_SOCKET</key><string>$DAEMON_SOCKET</string>
    <key>CLAUDE_SIDEBAR_SOURCE_ROOT</key><string>$REPO_DIR</string>
    <key>CLAUDE_SIDEBAR_CWD</key><string>$REPO_DIR</string>
    <key>CLAUDE_SIDEBAR_CONTEXT_FILE</key><string>$CONTEXT_FILE</string>
    <key>CLAUDE_CODE_PATH</key><string>$CLAUDE_BIN</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DAEMON_LOG</string>
  <key>StandardErrorPath</key><string>$DAEMON_LOG</string>
</dict>
</plist>
EOF

# 加载(优先新式 bootstrap,失败回退 load)
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null || true

# ---- 8. 浏览器自动化 MCP 注册到 Claude Code(幂等) ------------------------
if [[ -n "$CLAUDE_BIN" ]]; then
  "$CLAUDE_BIN" mcp add open-claude-in-chrome -- "$NODE_BIN" "$HOST_DIR/mcp-server.js" 2>/dev/null \
    || echo "  提示:open-claude-in-chrome MCP 可能已存在;如需重加:claude mcp add open-claude-in-chrome -- node \"$HOST_DIR/mcp-server.js\""
fi

# ---- 9. 等待 daemon socket 就绪 + 收尾 ------------------------------------
echo "等待 daemon socket..."
for _ in {1..50}; do [[ -S "$DAEMON_SOCKET" ]] && break; sleep 0.1; done
if [[ -S "$DAEMON_SOCKET" ]]; then
  echo "✔ 侧栏 daemon 已就绪:$DAEMON_SOCKET"
else
  echo "⚠ daemon socket 未在预期时间出现,请查看日志:$DAEMON_LOG"
fi

cat <<EOF

安装完成。请完全退出 Chrome(⌘Q)后重开。
  侧栏 daemon:   launchd $PLIST_LABEL(开机自启 / 崩溃自愈)
  relay 入口:    $RELAY_WRAPPER
  运行代码(真相源,run-from-clone): $HOST_DIR
  daemon 日志:   $DAEMON_LOG
EOF
