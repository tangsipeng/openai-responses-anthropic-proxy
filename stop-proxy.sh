#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

PID_FILE="${OPENAI_RESPONSES_PROXY_PID_FILE:-$SCRIPT_DIR/.openai-responses-anthropic-proxy.pid}"

if [ ! -f "$PID_FILE" ]; then
  echo "Proxy is not running (missing PID file: $PID_FILE)." >&2
  exit 1
fi

proxy_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -z "$proxy_pid" ]; then
  echo "PID file is empty: $PID_FILE" >&2
  rm -f "$PID_FILE"
  exit 1
fi

if ! kill -0 "$proxy_pid" 2>/dev/null; then
  echo "Process $proxy_pid is not running. Removing stale PID file." >&2
  rm -f "$PID_FILE"
  exit 1
fi

kill "$proxy_pid"

for _ in $(seq 1 50); do
  if ! kill -0 "$proxy_pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "Proxy stopped (pid $proxy_pid)."
    exit 0
  fi
  sleep 0.1
done

if kill -0 "$proxy_pid" 2>/dev/null; then
  echo "Proxy did not stop after SIGTERM. You can stop it manually with: kill -9 $proxy_pid" >&2
  exit 1
fi

rm -f "$PID_FILE"
echo "Proxy stopped (pid $proxy_pid)."
