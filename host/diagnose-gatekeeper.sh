#!/usr/bin/env bash
set -u

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This diagnostic is intended for macOS."
  exit 2
fi

RUNTIME_ROOT="$HOME/Library/Application Support/ClaudeSidebarHost"
REPORT="$RUNTIME_ROOT/gatekeeper-diagnostic-$(date +%Y%m%d-%H%M%S).txt"
mkdir -p "$RUNTIME_ROOT"

{
  echo "Claude Sidebar Gatekeeper diagnostic"
  echo "Generated: $(date)"
  echo "macOS: $(sw_vers 2>/dev/null | tr '\n' ' ')"
  echo "Arch: $(uname -m)"
  echo "Node: $(command -v node 2>/dev/null || true)"
  echo "Claude: $(command -v claude 2>/dev/null || true)"
  echo

  echo "=== Sidebar process tree ==="
  ps -axo pid=,ppid=,etime=,command= | grep -E 'ClaudeSidebarHost|chat-native-(host|relay)|mcp-server\.js|claude|bun' | grep -v grep || true
  echo

  echo "=== Daemon state ==="
  if [[ -f "$RUNTIME_ROOT/daemon.pid" ]]; then
    PID_VALUE="$(cat "$RUNTIME_ROOT/daemon.pid" 2>/dev/null || true)"
    echo "daemon.pid=$PID_VALUE"
    if [[ -n "$PID_VALUE" ]]; then
      ps -p "$PID_VALUE" -o pid=,ppid=,etime=,command= || true
    fi
  else
    echo "daemon.pid missing"
  fi
  echo

  echo "=== Recent .node files under macOS temp roots (last 30 minutes) ==="
  RECENT_FILE_LIST="$(mktemp)"
  find /private/var/folders /tmp -type f -name '*.node' -mmin -30 -print 2>/dev/null | sort -u > "$RECENT_FILE_LIST" || true
  cat "$RECENT_FILE_LIST"
  echo

  while IFS= read -r addon; do
    [[ -n "$addon" ]] || continue
    echo "--- $addon ---"
    ls -lO@ "$addon" 2>/dev/null || true
    file "$addon" 2>/dev/null || true
    echo "[codesign]"
    codesign -dv --verbose=4 "$addon" 2>&1 || true
    echo "[xattr]"
    xattr -l "$addon" 2>&1 || true
    echo "[otool -L]"
    otool -L "$addon" 2>&1 | head -n 40 || true
    echo "[native addon fingerprints]"
    strings "$addon" 2>/dev/null | grep -E -i 'better[-_ ]?sqlite|sqlite3|sharp|libvips|canvas|node[-_ ]?pty|swift_addon|computer_use|image|jpeg|png|webp' | head -n 80 || true
    echo
  done < "$RECENT_FILE_LIST"
  rm -f "$RECENT_FILE_LIST"

  echo "=== Recent unified log lines mentioning .node / Gatekeeper / code signature ==="
  log show --style compact --last 30m \
    --predicate 'eventMessage CONTAINS[c] ".node" OR eventMessage CONTAINS[c] "Gatekeeper" OR eventMessage CONTAINS[c] "code signature"' \
    2>/dev/null | tail -n 500 || true
  echo

  echo "=== Daemon log tail ==="
  tail -n 150 "$RUNTIME_ROOT/daemon.log" 2>/dev/null || true
  echo

  echo "=== Native relay log tail ==="
  tail -n 150 "$RUNTIME_ROOT/native-relay.log" 2>/dev/null || true
} > "$REPORT" 2>&1

echo "Diagnostic report written to:"
echo "$REPORT"
echo
echo "Recent native addon fingerprints:"
grep -E -i 'better[-_ ]?sqlite|sqlite3|sharp|libvips|canvas|node[-_ ]?pty|swift_addon|computer_use|jpeg|webp' "$REPORT" | head -n 30 || true
