#!/usr/bin/env bash
# ============================================================================
# open-claude-in-chrome 统一安装器
#   同时安装:① 侧栏 chat(direct,com.anthropic.claude_sidebar_chat → chat-native-host.js)
#            ② 浏览器自动化 host(com.anthropic.open_claude_in_chrome,18 工具)
#
# 设计:run-from-clone —— host 直接从本 clone 的 host/ 运行(Chrome 原生消息直连,
#       无 daemon/relay 中转),消除多副本漂移。仓库即运行的代码。
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

# ---- 0.5 环境预检测(装前查齐;🔴硬失败先列清单再退出,不装到一半才崩;🟡警告不阻断)----
# 顺带把 NODE_BIN / CLAUDE_BIN 设为全局供后续使用。
preflight() {
  local hard_fail=0
  echo "环境预检测:"

  # 🔴 macOS —— 脚本依赖 launchd 与 ~/Library,仅支持 macOS
  if [[ "$(uname -s)" == "Darwin" ]]; then echo "  ✔ 系统 macOS"
  else echo "  ✗ 系统非 macOS(当前 $(uname -s))—— 本安装脚本仅支持 macOS"; hard_fail=1; fi

  # 🔴 Node ≥ 20
  NODE_BIN="$(command -v node || true)"
  if [[ -z "$NODE_BIN" ]]; then
    echo "  ✗ 未找到 node —— 需 Node.js ≥ 20"; hard_fail=1
  else
    local major; major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [[ "$major" -lt 20 ]]; then echo "  ✗ Node 版本过低($("$NODE_BIN" -v))—— 需 ≥ 20"; hard_fail=1
    else echo "  ✔ Node $("$NODE_BIN" -v)"; fi
  fi

  # 🔴 npm —— 装 host 依赖(含 kiwi-schema / fzstd)
  if command -v npm >/dev/null 2>&1; then echo "  ✔ npm $(npm -v 2>/dev/null)"
  else echo "  ✗ 未找到 npm —— 无法安装 host 依赖"; hard_fail=1; fi

  # 🟡 claude CLI —— 侧栏 daemon 与浏览器自动化 MCP 都需要
  CLAUDE_BIN="$(command -v claude || true)"
  if [[ -n "$CLAUDE_BIN" ]]; then echo "  ✔ claude CLI"
  else echo "  ⚠ 未找到 claude CLI —— 侧栏 / 浏览器 MCP 需要它(装完请确保 claude 可用并已登录)"; fi

  # 🟡 git —— run-from-clone 更新(git pull)用
  if command -v git >/dev/null 2>&1; then echo "  ✔ git"
  else echo "  ⚠ 未找到 git —— run-from-clone 更新会用到"; fi

  # 🟡 至少一个受支持的 Chromium 浏览器(看 Application Support 目录)
  local found=""
  for b in "Google/Chrome" "Microsoft Edge" "BraveSoftware/Brave-Browser" "Arc/User Data"; do
    [[ -d "$HOME/Library/Application Support/$b" ]] && { found="$b"; break; }
  done
  if [[ -n "$found" ]]; then echo "  ✔ 检测到 Chromium 浏览器($found)"
  else echo "  ⚠ 未检测到受支持的 Chromium 浏览器(Chrome/Edge/Brave/Arc)—— 请先安装并在 chrome://extensions 加载 extension/"; fi

  if [[ "$hard_fail" -ne 0 ]]; then
    echo ""
    echo "环境预检测未通过(见上方 ✗)。请补齐必需项后重跑 ./install.sh。"
    exit 1
  fi
  echo ""
}
preflight

# ---- 1. 路径(NODE_BIN / CLAUDE_BIN 已在 preflight 设置) --------------------
HOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/host" && pwd)"   # <clone>/host
REPO_DIR="$(cd "$HOST_DIR/.." && pwd)"                          # <clone>

# ---- 2. host 依赖(含 Agent SDK) -----------------------------------------
if [[ ! -d "$HOST_DIR/node_modules/@anthropic-ai/claude-agent-sdk" ]]; then
  echo "安装 host 依赖(npm install)..."
  ( cd "$HOST_DIR" && npm install )
fi

# ---- 3. 运行期目录(只放日志/生成物,不放代码);direct 架构:Chrome 直连 chat-native-host.js ----
RUNTIME_ROOT="$HOME/Library/Application Support/ClaudeSidebarHost"
DATA_DIR="$HOME/Library/Application Support/ClaudeSidebarPureMap"
mkdir -p "$RUNTIME_ROOT" "$DATA_DIR"
CHAT_WRAPPER="$RUNTIME_ROOT/chat-native-host-wrapper.sh"
AUTO_WRAPPER="$RUNTIME_ROOT/native-host-wrapper.sh"
CHAT_LOG="$RUNTIME_ROOT/chat-native-host.log"
MCP_CONFIG="$HOST_DIR/sidebar-mcp.json"
NODE_DIR="$(dirname "$NODE_BIN")"

# ---- 4. 生成 sidebar-mcp.json(chat host 用 --strict-mcp-config 加载浏览器工具 MCP)---
cat > "$MCP_CONFIG" <<EOF
{
  "mcpServers": {
    "claude-sidebar-pure-map": {
      "type": "stdio",
      "command": "$NODE_BIN",
      "args": ["$HOST_DIR/mcp-server.js"],
      "env": {
        "CLAUDE_SIDEBAR_EXPECTED_VERSION": "0.15.3",
        "CLAUDE_SIDEBAR_EXPECTED_PROTOCOL": "13",
        "CLAUDE_SIDEBAR_DATA_DIR": "$DATA_DIR"
      },
      "timeout": 600000,
      "alwaysLoad": true
    }
  }
}
EOF

# 生成 chat direct wrapper(Chrome native messaging 直连 chat-native-host.js,无 daemon/relay)
cat > "$CHAT_WRAPPER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export CLAUDE_SIDEBAR_CLAUDE_BIN="$CLAUDE_BIN"
export CLAUDE_SIDEBAR_MCP_CONFIG="$MCP_CONFIG"
export CLAUDE_SIDEBAR_DATA_DIR="$DATA_DIR"
export CLAUDE_SIDEBAR_DEFAULT_CWD="$REPO_DIR"
exec "$NODE_BIN" "$HOST_DIR/chat-native-host.js" 2>>"$CHAT_LOG"
EOF
chmod +x "$CHAT_WRAPPER"

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
  write_manifest "com.anthropic.claude_sidebar_chat" "$CHAT_WRAPPER" "$d"       # 侧栏 chat(direct)
  write_manifest "com.anthropic.open_claude_in_chrome" "$AUTO_WRAPPER" "$d"     # 浏览器自动化
  rm -f "$d/com.sunny.claude_sidebar_chat.json" 2>/dev/null || true             # 清理 sunny 时代残留 manifest
done

# ---- 7. 清理已废弃的 daemon LaunchAgent(direct 架构不再需要 daemon/relay)----------------
# 旧安装可能留有 sunny 版或本项目的 --daemon LaunchAgent + relay,卸载并停用其 plist。
for old_label in com.sunny.claude-sidebar-daemon com.openclaude.sidebar-daemon; do
  launchctl bootout "gui/$(id -u)/$old_label" 2>/dev/null || true
done
for old_plist in "$HOME/Library/LaunchAgents/com.sunny.claude-sidebar-daemon.plist" "$HOME/Library/LaunchAgents/com.openclaude.sidebar-daemon.plist"; do
  [[ -f "$old_plist" ]] && mv "$old_plist" "$old_plist.disabled" 2>/dev/null || true
done
rm -f "$RUNTIME_ROOT/chat-native-relay-wrapper.sh" 2>/dev/null || true  # 旧 relay wrapper(relay.js 已删)

# ---- 8. 浏览器自动化 MCP 注册到 Claude Code(幂等) ------------------------
if [[ -n "$CLAUDE_BIN" ]]; then
  "$CLAUDE_BIN" mcp add open-claude-in-chrome -- "$NODE_BIN" "$HOST_DIR/mcp-server.js" 2>/dev/null \
    || echo "  提示:open-claude-in-chrome MCP 可能已存在;如需重加:claude mcp add open-claude-in-chrome -- node \"$HOST_DIR/mcp-server.js\""
fi

# ---- 9. 收尾 --------------------------------------------------------------
cat <<EOF

安装完成。请完全退出浏览器(⌘Q)后重开。
  侧栏 chat(direct):         $CHAT_WRAPPER
  浏览器自动化 host:          $AUTO_WRAPPER
  MCP 配置(chat 浏览器工具):  $MCP_CONFIG
  运行代码(真相源,run-from-clone): $HOST_DIR
  chat host 日志:             $CHAT_LOG
EOF
