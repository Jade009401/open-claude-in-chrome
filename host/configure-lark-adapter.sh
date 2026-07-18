#!/usr/bin/env bash
set -euo pipefail

RUNTIME_ROOT="${CLAUDE_SIDEBAR_RUNTIME_ROOT:-$HOME/Library/Application Support/ClaudeSidebarHost}"
CONFIG_PATH="${CLAUDE_SIDEBAR_LARK_CONFIG:-$RUNTIME_ROOT/lark-adapter.json}"
NODE_BIN="$(command -v node || true)"

if [[ -z "$NODE_BIN" ]]; then
  echo "Error: node was not found in PATH." >&2
  exit 1
fi

printf 'Lark/Feishu App ID: '
IFS= read -r APP_ID
printf 'Lark/Feishu App Secret: '
IFS= read -r -s APP_SECRET
printf '\nDomain [lark/feishu] (default: lark): '
IFS= read -r DOMAIN
DOMAIN="${DOMAIN:-lark}"

case "$DOMAIN" in
  lark|feishu) ;;
  *)
    echo "Error: domain must be lark or feishu." >&2
    exit 1
    ;;
esac

if [[ -z "$APP_ID" || -z "$APP_SECRET" ]]; then
  echo "Error: App ID and App Secret are required." >&2
  exit 1
fi

mkdir -p "$(dirname "$CONFIG_PATH")"
APP_ID="$APP_ID" APP_SECRET="$APP_SECRET" DOMAIN="$DOMAIN" CONFIG_PATH="$CONFIG_PATH" \
  "$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
const payload = {
  appId: process.env.APP_ID,
  appSecret: process.env.APP_SECRET,
  domain: process.env.DOMAIN,
};
fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
fs.chmodSync(process.env.CONFIG_PATH, 0o600);
NODE

printf '\nSaved Lark Adapter configuration:\n  %s\n' "$CONFIG_PATH"
printf 'Permissions: 600 (current user only)\n'
printf 'The adapter reads this file lazily; the sidebar daemon does not need a restart.\n'
