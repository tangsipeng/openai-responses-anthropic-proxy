# OpenAI Responses Anthropic Proxy

[中文说明](./README.zh-CN.md)

Standalone local HTTP proxy that exposes Anthropic-compatible `POST /v1/messages`
semantics to Claude Code while forwarding requests to OpenAI's Responses API or
OpenAI-compatible upstreams.

## What It Does

- accepts Anthropic-style `POST /v1/messages`
- forwards to `POST /v1/responses`
- supports streaming text responses
- translates OpenAI function calls into Anthropic `tool_use`
- preserves multi-turn tool continuation with `previous_response_id`
- works with OpenAI and compatible providers that implement the Responses API
- emits one structured log line per request

## Runtime Requirement

- Bun `>= 1.3`

## Quick Start

1. Install dependencies:

```bash
bun install
```

2. Create your env file:

```bash
cp .env.example .env
```

3. Start the proxy:

```bash
set -a
source .env
set +a
bun run start
```

You can also pass the same values as CLI flags:

```bash
bun run start -- \
  --listen-port 4141 \
  --upstream-url https://api.openai.com \
  --upstream-key "$OPENAI_API_KEY" \
  --upstream-model gpt-4.1 \
  --state-file .openai-responses-anthropic-proxy-state.json
```

## Helper Scripts

The project includes lightweight lifecycle scripts for running the proxy as a
background service from the project directory:

```bash
./start-proxy.sh
./proxy-status.sh
./stop-proxy.sh
```

What they do:

- `start-proxy.sh` starts the proxy in the background, writes the PID to
  `.openai-responses-anthropic-proxy.pid`, and appends logs to
  `.openai-responses-anthropic-proxy.log`
- `proxy-status.sh` reports whether the proxy is `running`, `stale-pid`, or
  `stopped`
- `stop-proxy.sh` stops the running proxy using the saved PID

If needed, you can override the PID file path with
`OPENAI_RESPONSES_PROXY_PID_FILE`.

## Claude Code Configuration

Point Claude Code to the local proxy:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4141
export ANTHROPIC_API_KEY=dummy
export ANTHROPIC_MODEL=my-proxy-codex
```

`dummy` is only a placeholder required by Claude Code. The real upstream key is
configured on the proxy side via `.env` or CLI flags. `ANTHROPIC_MODEL` is the
name Claude Code will display locally; the proxy still forwards to the real
upstream model configured with `OPENAI_RESPONSES_UPSTREAM_MODEL` or
`--upstream-model`.

By default the proxy persists tool continuation state to
`.openai-responses-anthropic-proxy-state.json`, so `previous_response_id`
survives a restart. Override it with `OPENAI_RESPONSES_STATE_FILE` or
`--state-file`.

## Logs

Each `POST /v1/messages` request emits one structured line to stdout:

```text
[openai-responses-proxy] request {"ts":"2026-04-06T03:06:30.090Z","method":"POST","path":"/v1/messages","model":"claude-sonnet-test","stream":true,"status":200,"upstream_status":200,"duration_ms":1209,"error":null}
```

This lets you confirm that Claude Code is actually going through the proxy.

## Verified Usage

The screenshot below shows a real Claude Code session using this proxy to ask
`分析这个项目的结构` and receive a normal structured answer instead of a tool
continuation error:

![Claude Code using the proxy successfully](./docs/assets/claude-code-usage-proof.png)

## Change Log

- 2026-04-08
  - added richer Responses → Anthropic translation for reasoning summaries,
    refusal text, cache-token usage fields, and incomplete/max-token stop reason
  - expanded streaming SSE handling for reasoning and refusal deltas
  - added regression coverage for reasoning, refusal, usage normalization,
    reasoning effort mapping, and streaming behavior
  - added `start-proxy.sh`, `stop-proxy.sh`, and `proxy-status.sh` for local
    proxy lifecycle management
- 2026-04-07
  - added verified usage screenshot to the README
  - fixed tool continuation compatibility for Responses upstreams
- 2026-04-06
  - initial standalone proxy release
  - added request logging with local timestamps and timezone offset

## Environment Variables

- `OPENAI_RESPONSES_PROXY_HOST`
- `OPENAI_RESPONSES_PROXY_PORT`
- `OPENAI_RESPONSES_PROXY_PID_FILE`
- `OPENAI_RESPONSES_UPSTREAM_URL`
- `OPENAI_RESPONSES_UPSTREAM_KEY`
- `OPENAI_RESPONSES_UPSTREAM_MODEL`
- `OPENAI_RESPONSES_STATE_FILE`

## Docker

Build the image:

```bash
docker build -t openai-responses-anthropic-proxy .
```

Run it:

```bash
docker run --rm \
  -p 4141:4141 \
  -e OPENAI_RESPONSES_PROXY_HOST=0.0.0.0 \
  -e OPENAI_RESPONSES_PROXY_PORT=4141 \
  -e OPENAI_RESPONSES_UPSTREAM_URL=https://api.openai.com \
  -e OPENAI_RESPONSES_UPSTREAM_KEY="$OPENAI_API_KEY" \
  -e OPENAI_RESPONSES_UPSTREAM_MODEL=gpt-4.1 \
  openai-responses-anthropic-proxy
```

## Build A Single Binary

```bash
bun run build:binary
```

This writes a standalone executable to:

```text
dist/openai-responses-anthropic-proxy
```

## Development Commands

```bash
bun run test
bun run typecheck
```

## Project Structure

```text
src/cli.ts
src/server.ts
src/translate.ts
src/state.ts
src/config.ts
src/types.ts
start-proxy.sh
stop-proxy.sh
proxy-status.sh
```
