# OpenAI Responses Anthropic Proxy

一个独立运行的本地 HTTP 代理。

它对外暴露 Anthropic 兼容的 `POST /v1/messages` 接口，让 Claude Code 可以像连接 Anthropic 一样连接它；代理内部再把请求转发到 OpenAI Responses API，或者兼容 Responses API 的第三方服务商。

## 功能概览

- 接收 Anthropic 风格的 `POST /v1/messages`
- 转发到 OpenAI 风格的 `POST /v1/responses`
- 支持非流式响应
- 支持流式文本响应
- 支持工具调用转换为 Anthropic `tool_use`
- 支持工具结果续接与 `previous_response_id`
- 支持 OpenAI 官方 Responses API
- 支持兼容 Responses API 的 OpenAI-compatible 服务商
- 每次请求输出一条结构化访问日志，方便排查 Claude Code 是否真的走了代理

## 运行要求

- Bun `>= 1.3`

## 快速开始

1. 安装依赖：

```bash
bun install
```

2. 复制环境变量模板：

```bash
cp .env.example .env
```

3. 按需修改 `.env` 中的上游配置。

4. 启动代理：

```bash
set -a
source .env
set +a
bun run start
```

你也可以不用 `.env`，直接通过命令行传参：

```bash
bun run start -- \
  --listen-port 4141 \
  --upstream-url https://api.openai.com \
  --upstream-key "$OPENAI_API_KEY" \
  --upstream-model gpt-4.1 \
  --state-file .openai-responses-anthropic-proxy-state.json
```

## 辅助脚本

项目内置了几个轻量脚本，方便把代理当作后台服务管理：

```bash
./start-proxy.sh
./proxy-status.sh
./stop-proxy.sh
```

它们的作用分别是：

- `start-proxy.sh`：后台启动代理，把 PID 写入
  `.openai-responses-anthropic-proxy.pid`，并把日志追加到
  `.openai-responses-anthropic-proxy.log`
- `proxy-status.sh`：输出当前状态，可能是 `running`、`stale-pid` 或
  `stopped`
- `stop-proxy.sh`：读取 PID 文件并停止正在运行的代理进程

如果需要自定义 PID 文件路径，可以设置
`OPENAI_RESPONSES_PROXY_PID_FILE`。

## 给 Claude Code 使用

启动代理后，把 Claude Code 指到本地代理：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4141
export ANTHROPIC_API_KEY=dummy
export ANTHROPIC_MODEL=my-proxy-codex
```

这里的 `dummy` 只是占位。Claude Code 需要这个变量非空，但真正访问上游的密钥由代理自己的 `.env` 或命令行参数提供。`ANTHROPIC_MODEL` 是 Claude Code 本地显示的模型名；代理实际转发到的真实上游模型仍然由 `OPENAI_RESPONSES_UPSTREAM_MODEL` 或 `--upstream-model` 决定。

代理默认会把工具续接状态持久化到
`.openai-responses-anthropic-proxy-state.json`，这样重启后还能继续使用
`previous_response_id`。如果要自定义位置，可以设置
`OPENAI_RESPONSES_STATE_FILE` 或 `--state-file`。

## 日志

代理会对每次 `POST /v1/messages` 输出一条结构化日志：

```text
[openai-responses-proxy] request {"ts":"2026-04-06T03:06:30.090Z","method":"POST","path":"/v1/messages","model":"claude-sonnet-test","stream":true,"status":200,"upstream_status":200,"duration_ms":1209,"error":null}
```

你可以通过日志确认：

- Claude Code 是否真的走了这个代理
- 当前请求是否是流式
- 上游是否成功返回
- 整体耗时大概多少

## 正常使用截图

下面这张图是一次真实的 Claude Code 会话，提示词为
`分析这个项目的结构`。它通过这个代理正常返回了结构化分析结果，而不是
工具续接错误：

![Claude Code 通过代理正常工作](./docs/assets/claude-code-usage-proof.png)

## 版本记录

- 2026-04-08
  - 增强了 Responses → Anthropic 的协议转换，补上 reasoning summary、refusal 文本、cache token usage 字段和 incomplete/max-token stop reason
  - 扩展了 streaming SSE 处理，支持 reasoning 和 refusal 增量事件
  - 补充了 reasoning、refusal、usage 归一化、reasoning effort 映射和 streaming 行为的回归测试
  - 新增 `start-proxy.sh`、`stop-proxy.sh` 和 `proxy-status.sh`，方便本地管理代理进程
- 2026-04-07
  - README 增加真实使用截图
  - 修复 Responses 上游的工具续接兼容性
- 2026-04-06
  - 初始版本发布
  - 增加带本地时区偏移的请求日志

## 环境变量

- `OPENAI_RESPONSES_PROXY_HOST`
- `OPENAI_RESPONSES_PROXY_PORT`
- `OPENAI_RESPONSES_PROXY_PID_FILE`
- `OPENAI_RESPONSES_UPSTREAM_URL`
- `OPENAI_RESPONSES_UPSTREAM_KEY`
- `OPENAI_RESPONSES_UPSTREAM_MODEL`
- `OPENAI_RESPONSES_STATE_FILE`

## Docker 使用

构建镜像：

```bash
docker build -t openai-responses-anthropic-proxy .
```

运行镜像：

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

## 构建单文件可执行程序

```bash
bun run build:binary
```

生成结果在：

```text
dist/openai-responses-anthropic-proxy
```

## 开发命令

```bash
bun run test
bun run typecheck
```

## 目录结构

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
