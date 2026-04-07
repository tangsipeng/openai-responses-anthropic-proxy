#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="${OPENAI_RESPONSES_PROXY_PID_FILE:-$SCRIPT_DIR/.openai-responses-anthropic-proxy.pid}"
LOG_FILE="$SCRIPT_DIR/.openai-responses-anthropic-proxy.log"

if [ -f "$PID_FILE" ]; then
  proxy_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$proxy_pid" ] && kill -0 "$proxy_pid" 2>/dev/null; then
    status="running"
  else
    status="stale-pid"
  fi
else
  proxy_pid=""
  status="stopped"
fi

echo "status: $status"
echo "pid_file: $PID_FILE"
if [ -n "$proxy_pid" ]; then
  echo "pid: $proxy_pid"
fi
echo "log_file: $LOG_FILE"
