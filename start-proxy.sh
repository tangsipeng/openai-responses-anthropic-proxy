#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required but was not found in PATH." >&2
  exit 1
fi

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

PROXY_HOST="${OPENAI_RESPONSES_PROXY_HOST:-127.0.0.1}"
PROXY_PORT="${OPENAI_RESPONSES_PROXY_PORT:-4141}"
PID_FILE="${OPENAI_RESPONSES_PROXY_PID_FILE:-$SCRIPT_DIR/.openai-responses-anthropic-proxy.pid}"
UPSTREAM_URL="${OPENAI_RESPONSES_UPSTREAM_URL:-}"
UPSTREAM_KEY="${OPENAI_RESPONSES_UPSTREAM_KEY:-}"

if [ -z "$UPSTREAM_URL" ]; then
  echo "Missing OPENAI_RESPONSES_UPSTREAM_URL. Set it in .env or the environment." >&2
  exit 1
fi

if [ -z "$UPSTREAM_KEY" ]; then
  echo "Missing OPENAI_RESPONSES_UPSTREAM_KEY. Set it in .env or the environment." >&2
  exit 1
fi

if [ -f "$PID_FILE" ]; then
  existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "Proxy is already running (pid $existing_pid)." >&2
    echo "PID file: $PID_FILE" >&2
    exit 1
  fi
  rm -f "$PID_FILE"
fi

bun run start >> "$SCRIPT_DIR/.openai-responses-anthropic-proxy.log" 2>&1 &
proxy_pid="$!"
echo "$proxy_pid" > "$PID_FILE"

ready="false"
for _ in $(seq 1 50); do
  if nc -z "$PROXY_HOST" "$PROXY_PORT" 2>/dev/null; then
    ready="true"
    break
  fi

  if ! kill -0 "$proxy_pid" 2>/dev/null; then
    echo "Proxy exited before becoming ready. See .openai-responses-anthropic-proxy.log" >&2
    rm -f "$PID_FILE"
    wait "$proxy_pid" || true
    exit 1
  fi

  sleep 0.1
done

if [ "$ready" != "true" ]; then
  echo "Proxy did not start listening on http://$PROXY_HOST:$PROXY_PORT." >&2
  rm -f "$PID_FILE"
  kill "$proxy_pid" 2>/dev/null || true
  wait "$proxy_pid" 2>/dev/null || true
  exit 1
fi

echo "Proxy started: http://$PROXY_HOST:$PROXY_PORT"
echo "PID: $proxy_pid"
echo "PID file: $PID_FILE"
echo "Log file: $SCRIPT_DIR/.openai-responses-anthropic-proxy.log"
