import { randomUUID } from 'crypto'
import { ProxyStateStore } from './state.js'
import {
  translateAnthropicRequestToUpstream,
  translateUpstreamResponseToAnthropicMessage,
} from './translate.js'
import type {
  AnthropicMessageResponse,
  AnthropicMessagesRequest,
  AnthropicRawContentBlockDeltaEvent,
  AnthropicRawContentBlockStartEvent,
  AnthropicRawContentBlockStopEvent,
  AnthropicRawMessageDeltaEvent,
  AnthropicRawMessageStartEvent,
  AnthropicRawMessageStopEvent,
  ProxyConfig,
  RunningOpenAIResponsesCompatProxy,
  UpstreamResponse,
} from './types.js'
export type { RunningOpenAIResponsesCompatProxy } from './types.js'

type SSEChunk = {
  event: string
  data: unknown
}

type ParsedSSEEvent = {
  event: string
  data: unknown
}

type StreamAccumulator = {
  upstreamResponseId: string | null
  upstreamResponse: UpstreamResponse | null
  requestedModel: string
  anthropicMessageId: string
  messageStarted: boolean
  textBlockIndex: number | null
  nextContentBlockIndex: number
  emittedToolCallIds: Set<string>
  pendingFunctionCalls: Map<
    number,
    {
      call_id: string
      name: string
      arguments: string
    }
  >
}

type UpstreamHandlingResult = {
  response: Response
  upstreamStatus: number | null
  error: string | null
}

type MessagesRequestResult = UpstreamHandlingResult & {
  model: string | null
  stream: boolean | null
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  })
}

function buildUpstreamURL(base: string): string {
  const url = new URL(base)
  const pathname = url.pathname.replace(/\/+$/, '')

  if (!pathname || pathname === '/') {
    url.pathname = '/v1/responses'
    return url.toString()
  }

  if (pathname.endsWith('/responses')) {
    url.pathname = pathname
    return url.toString()
  }

  if (pathname.endsWith('/v1')) {
    url.pathname = `${pathname}/responses`
    return url.toString()
  }

  url.pathname = `${pathname}/v1/responses`
  return url.toString()
}

function errorResponse(
  status: number,
  message: string,
  type = 'api_error',
): Response {
  return jsonResponse(
    {
      type: 'error',
      error: {
        type,
        message,
      },
    },
    status,
  )
}

async function parseJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function formatLocalTimestamp(date: Date): string {
  const pad = (value: number, size = 2): string =>
    value.toString().padStart(size, '0')

  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteOffsetMinutes = Math.abs(offsetMinutes)
  const offsetHours = Math.floor(absoluteOffsetMinutes / 60)
  const offsetRemainderMinutes = absoluteOffsetMinutes % 60

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(offsetHours)}:${pad(offsetRemainderMinutes)}`
  )
}

function logRequest(
  config: ProxyConfig,
  entry: {
    method: string
    path: string
    model: string | null
    stream: boolean | null
    status: number
    upstreamStatus: number | null
    durationMs: number
    error: string | null
  },
): void {
  if (!config.logger) return

  config.logger(
    `[openai-responses-proxy] request ${JSON.stringify({
      ts: formatLocalTimestamp(new Date()),
      method: entry.method,
      path: entry.path,
      model: entry.model,
      stream: entry.stream,
      status: entry.status,
      upstream_status: entry.upstreamStatus,
      duration_ms: entry.durationMs,
      error: entry.error,
    })}`,
  )
}

function upstreamPayloadErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }

  if (
    'error' in payload &&
    payload.error &&
    typeof payload.error === 'object' &&
    !Array.isArray(payload.error) &&
    'message' in payload.error &&
    typeof payload.error.message === 'string'
  ) {
    return payload.error.message
  }

  if ('message' in payload && typeof payload.message === 'string') {
    return payload.message
  }

  return null
}

function isValidUpstreamResponsePayload(payload: unknown): payload is UpstreamResponse {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false
  }

  const candidate = payload as Record<string, unknown>
  const hasRecognizableShape =
    typeof candidate.id === 'string' ||
    Array.isArray(candidate.output) ||
    typeof candidate.output_text === 'string' ||
    typeof candidate.status === 'string'

  if (!hasRecognizableShape) {
    return false
  }

  if ('output' in candidate && candidate.output !== undefined && !Array.isArray(candidate.output)) {
    return false
  }

  if ('output_text' in candidate && candidate.output_text !== undefined && typeof candidate.output_text !== 'string') {
    return false
  }

  return true
}

async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<ParsedSSEEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')

      const lines = rawEvent.split(/\r?\n/)
      let event = 'message'
      const dataLines: string[] = []

      for (const line of lines) {
        if (line.startsWith('event:')) {
          event = line.slice('event:'.length).trim()
          continue
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trim())
        }
      }

      const dataText = dataLines.join('\n')
      let parsed: unknown = dataText
      if (dataText) {
        try {
          parsed = JSON.parse(dataText)
        } catch {
          parsed = dataText
        }
      }

      yield { event, data: parsed }
    }
  }
}

function eventTypeOf(event: ParsedSSEEvent): string {
  if (
    event.data &&
    typeof event.data === 'object' &&
    'type' in event.data &&
    typeof (event.data as { type?: unknown }).type === 'string'
  ) {
    return (event.data as { type: string }).type
  }

  return event.event
}

function enqueueSSE(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  chunk: SSEChunk,
): void {
  controller.enqueue(
    encoder.encode(
      `event: ${chunk.event}\ndata: ${JSON.stringify(chunk.data)}\n\n`,
    ),
  )
}

function createMessageStartEvent(
  accumulator: StreamAccumulator,
): AnthropicRawMessageStartEvent {
  return {
    type: 'message_start',
    message: {
      id: accumulator.anthropicMessageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: accumulator.requestedModel,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    },
  }
}

function ensureMessageStarted(
  accumulator: StreamAccumulator,
  queue: SSEChunk[],
): void {
  if (accumulator.messageStarted) return
  accumulator.messageStarted = true
  queue.push({
    event: 'message_start',
    data: createMessageStartEvent(accumulator),
  })
}

function ensureTextBlockStarted(
  accumulator: StreamAccumulator,
  queue: SSEChunk[],
): number {
  if (accumulator.textBlockIndex !== null) {
    return accumulator.textBlockIndex
  }

  ensureMessageStarted(accumulator, queue)
  const index = accumulator.nextContentBlockIndex
  accumulator.nextContentBlockIndex += 1
  accumulator.textBlockIndex = index

  const event: AnthropicRawContentBlockStartEvent = {
    type: 'content_block_start',
    index,
    content_block: {
      type: 'text',
      text: '',
      citations: null,
    },
  }

  queue.push({
    event: 'content_block_start',
    data: event,
  })

  return index
}

function closeTextBlock(
  accumulator: StreamAccumulator,
  queue: SSEChunk[],
): void {
  if (accumulator.textBlockIndex === null) return
  const event: AnthropicRawContentBlockStopEvent = {
    type: 'content_block_stop',
    index: accumulator.textBlockIndex,
  }
  queue.push({
    event: 'content_block_stop',
    data: event,
  })
  accumulator.textBlockIndex = null
}

function emitToolUseBlock(
  accumulator: StreamAccumulator,
  queue: SSEChunk[],
  toolCall: { call_id: string; name: string; arguments: string },
): void {
  if (accumulator.emittedToolCallIds.has(toolCall.call_id)) {
    return
  }
  accumulator.emittedToolCallIds.add(toolCall.call_id)

  closeTextBlock(accumulator, queue)
  ensureMessageStarted(accumulator, queue)

  let input: unknown = {}
  try {
    input = toolCall.arguments ? JSON.parse(toolCall.arguments) : {}
  } catch {
    input = {}
  }

  const index = accumulator.nextContentBlockIndex
  accumulator.nextContentBlockIndex += 1

  const startEvent: AnthropicRawContentBlockStartEvent = {
    type: 'content_block_start',
    index,
    content_block: {
      type: 'tool_use',
      id: toolCall.call_id,
      name: toolCall.name,
      input,
    },
  }
  const stopEvent: AnthropicRawContentBlockStopEvent = {
    type: 'content_block_stop',
    index,
  }

  queue.push({
    event: 'content_block_start',
    data: startEvent,
  })
  queue.push({
    event: 'content_block_stop',
    data: stopEvent,
  })
}

function messageDeltaFromResponse(
  response: UpstreamResponse,
  anthropicMessage: AnthropicMessageResponse,
): AnthropicRawMessageDeltaEvent {
  return {
    type: 'message_delta',
    delta: {
      stop_reason: anthropicMessage.stop_reason,
      stop_sequence: anthropicMessage.stop_sequence,
    },
    usage: {
      output_tokens: anthropicMessage.usage.output_tokens,
    },
  }
}

function finalizeStreamFromResponse(
  accumulator: StreamAccumulator,
  queue: SSEChunk[],
  response: UpstreamResponse,
  state: ProxyStateStore,
): void {
  accumulator.upstreamResponse = response
  accumulator.upstreamResponseId = response.id

  const anthropicMessage = translateUpstreamResponseToAnthropicMessage(
    response,
    accumulator.requestedModel,
  )

  ensureMessageStarted(accumulator, queue)

  const textBlocks = anthropicMessage.content.filter(
    block => block.type === 'text',
  )
  const toolUseBlocks = anthropicMessage.content.filter(
    block => block.type === 'tool_use',
  )

  if (
    accumulator.textBlockIndex === null &&
    accumulator.emittedToolCallIds.size === 0 &&
    textBlocks.length === 0 &&
    toolUseBlocks.length === 0
  ) {
    closeTextBlock(accumulator, queue)
  }

  if (
    accumulator.textBlockIndex === null &&
    accumulator.emittedToolCallIds.size === 0 &&
    textBlocks.length > 0
  ) {
    const combined = textBlocks.map(block => block.text).join('')
    const index = ensureTextBlockStarted(accumulator, queue)
    const deltaEvent: AnthropicRawContentBlockDeltaEvent = {
      type: 'content_block_delta',
      index,
      delta: {
        type: 'text_delta',
        text: combined,
      },
    }
    queue.push({
      event: 'content_block_delta',
      data: deltaEvent,
    })
  }

  for (const block of toolUseBlocks) {
    emitToolUseBlock(accumulator, queue, {
      call_id: block.id,
      name: block.name,
      arguments: JSON.stringify(block.input ?? {}),
    })
  }

  closeTextBlock(accumulator, queue)

  queue.push({
    event: 'message_delta',
    data: messageDeltaFromResponse(response, anthropicMessage),
  })
  queue.push({
    event: 'message_stop',
    data: {
      type: 'message_stop',
    } satisfies AnthropicRawMessageStopEvent,
  })

  state.rememberAssistantResponse(anthropicMessage.content, response.id)
}

function handleParsedUpstreamEvent(
  parsedEvent: ParsedSSEEvent,
  accumulator: StreamAccumulator,
  queue: SSEChunk[],
  state: ProxyStateStore,
): void {
  const type = eventTypeOf(parsedEvent)

  if (type === 'response.output_text.delta') {
    const payload =
      parsedEvent.data && typeof parsedEvent.data === 'object'
        ? (parsedEvent.data as { delta?: unknown })
        : null
    const delta = typeof payload?.delta === 'string' ? payload.delta : ''
    if (!delta) return
    const index = ensureTextBlockStarted(accumulator, queue)
    const event: AnthropicRawContentBlockDeltaEvent = {
      type: 'content_block_delta',
      index,
      delta: {
        type: 'text_delta',
        text: delta,
      },
    }
    queue.push({
      event: 'content_block_delta',
      data: event,
    })
    return
  }

  if (type === 'response.output_item.added') {
    const payload =
      parsedEvent.data && typeof parsedEvent.data === 'object'
        ? (parsedEvent.data as {
            output_index?: unknown
            item?: {
              type?: unknown
              call_id?: unknown
              name?: unknown
              arguments?: unknown
            }
          })
        : null
    if (
      typeof payload?.output_index === 'number' &&
      payload.item?.type === 'function_call' &&
      typeof payload.item.call_id === 'string' &&
      typeof payload.item.name === 'string'
    ) {
      accumulator.pendingFunctionCalls.set(payload.output_index, {
        call_id: payload.item.call_id,
        name: payload.item.name,
        arguments:
          typeof payload.item.arguments === 'string' ? payload.item.arguments : '',
      })
    }
    return
  }

  if (type === 'response.function_call_arguments.delta') {
    const payload =
      parsedEvent.data && typeof parsedEvent.data === 'object'
        ? (parsedEvent.data as { output_index?: unknown; delta?: unknown })
        : null
    if (
      typeof payload?.output_index === 'number' &&
      typeof payload.delta === 'string'
    ) {
      const current = accumulator.pendingFunctionCalls.get(payload.output_index)
      if (current) {
        current.arguments += payload.delta
      }
    }
    return
  }

  if (type === 'response.function_call_arguments.done') {
    const payload =
      parsedEvent.data && typeof parsedEvent.data === 'object'
        ? (parsedEvent.data as {
            output_index?: unknown
            call_id?: unknown
            name?: unknown
            arguments?: unknown
          })
        : null
    const byIndex =
      typeof payload?.output_index === 'number'
        ? accumulator.pendingFunctionCalls.get(payload.output_index)
        : undefined
    const toolCall =
      byIndex ??
      (typeof payload?.call_id === 'string' && typeof payload?.name === 'string'
        ? {
            call_id: payload.call_id,
            name: payload.name,
            arguments:
              typeof payload.arguments === 'string' ? payload.arguments : '',
          }
        : null)

    if (toolCall) {
      emitToolUseBlock(accumulator, queue, toolCall)
    }
    return
  }

  if (type === 'response.output_item.done') {
    const payload =
      parsedEvent.data && typeof parsedEvent.data === 'object'
        ? (parsedEvent.data as {
            item?: {
              type?: unknown
              call_id?: unknown
              name?: unknown
              arguments?: unknown
            }
          })
        : null
    if (
      payload?.item?.type === 'function_call' &&
      typeof payload.item.call_id === 'string' &&
      typeof payload.item.name === 'string'
    ) {
      emitToolUseBlock(accumulator, queue, {
        call_id: payload.item.call_id,
        name: payload.item.name,
        arguments:
          typeof payload.item.arguments === 'string' ? payload.item.arguments : '',
      })
    }
    return
  }

  if (type === 'response.completed') {
    const payload =
      parsedEvent.data && typeof parsedEvent.data === 'object'
        ? (parsedEvent.data as { response?: UpstreamResponse })
        : null
    const response = payload?.response
    if (response) {
      finalizeStreamFromResponse(accumulator, queue, response, state)
    }
    return
  }
}

async function makeUpstreamRequest(
  config: ProxyConfig,
  body: unknown,
  stream: boolean,
): Promise<Response> {
  const headers = new Headers({
    'content-type': 'application/json',
    Authorization: `Bearer ${config.upstreamKey}`,
    ...(config.upstreamHeaders ?? {}),
  })

  return await fetch(buildUpstreamURL(config.upstreamURL), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

async function handleNonStreamingMessagesRequest(
  config: ProxyConfig,
  state: ProxyStateStore,
  anthropicRequest: AnthropicMessagesRequest,
): Promise<UpstreamHandlingResult> {
  const upstreamRequest = translateAnthropicRequestToUpstream(
    anthropicRequest,
    config.upstreamModel ?? anthropicRequest.model,
    state,
  )
  upstreamRequest.body.stream = false

  const upstreamResponse = await makeUpstreamRequest(
    config,
    upstreamRequest.body,
    false,
  )

  if (!upstreamResponse.ok) {
    const errorBody = await parseJsonSafe(upstreamResponse)
    const message =
      upstreamPayloadErrorMessage(errorBody) ??
      `Upstream error (${upstreamResponse.status})`
    return {
      response: errorResponse(upstreamResponse.status, message),
      upstreamStatus: upstreamResponse.status,
      error: message,
    }
  }

  const upstreamJson = await parseJsonSafe(upstreamResponse)
  if (!isValidUpstreamResponsePayload(upstreamJson)) {
    const message =
      upstreamPayloadErrorMessage(upstreamJson) ??
      'Upstream returned an invalid response payload'
    return {
      response: errorResponse(502, message),
      upstreamStatus: upstreamResponse.status,
      error: message,
    }
  }
  const anthropicMessage = translateUpstreamResponseToAnthropicMessage(
    upstreamJson,
    anthropicRequest.model,
  )

  state.rememberAssistantResponse(anthropicMessage.content, upstreamJson.id)
  return {
    response: jsonResponse(anthropicMessage),
    upstreamStatus: upstreamResponse.status,
    error: null,
  }
}

async function handleStreamingMessagesRequest(
  config: ProxyConfig,
  state: ProxyStateStore,
  anthropicRequest: AnthropicMessagesRequest,
): Promise<UpstreamHandlingResult> {
  const upstreamRequest = translateAnthropicRequestToUpstream(
    anthropicRequest,
    config.upstreamModel ?? anthropicRequest.model,
    state,
  )
  upstreamRequest.body.stream = true

  const upstreamResponse = await makeUpstreamRequest(
    config,
    upstreamRequest.body,
    true,
  )

  if (!upstreamResponse.ok) {
    const errorBody = await parseJsonSafe(upstreamResponse)
    const message =
      upstreamPayloadErrorMessage(errorBody) ??
      `Upstream error (${upstreamResponse.status})`
    return {
      response: errorResponse(upstreamResponse.status, message),
      upstreamStatus: upstreamResponse.status,
      error: message,
    }
  }

  const contentType = upstreamResponse.headers.get('content-type') ?? ''
  if (!upstreamResponse.body) {
    return {
      response: errorResponse(502, 'Upstream response body was empty'),
      upstreamStatus: upstreamResponse.status,
      error: 'Upstream response body was empty',
    }
  }

  const encoder = new TextEncoder()
  const accumulator: StreamAccumulator = {
    upstreamResponseId: null,
    upstreamResponse: null,
    requestedModel: anthropicRequest.model,
    anthropicMessageId: `msg_${randomUUID()}`,
    messageStarted: false,
    textBlockIndex: null,
    nextContentBlockIndex: 0,
    emittedToolCallIds: new Set<string>(),
    pendingFunctionCalls: new Map(),
  }

  const stream = new ReadableStream<Uint8Array>({
    start: async controller => {
      try {
        if (contentType.includes('application/json')) {
          const upstreamJson = await parseJsonSafe(upstreamResponse)
          if (!isValidUpstreamResponsePayload(upstreamJson)) {
            throw new Error(
              upstreamPayloadErrorMessage(upstreamJson) ??
                'Upstream returned an invalid response payload',
            )
          }
          const queue: SSEChunk[] = []
          finalizeStreamFromResponse(accumulator, queue, upstreamJson, state)
          for (const chunk of queue) {
            enqueueSSE(controller, encoder, chunk)
          }
          controller.close()
          return
        }

        for await (const parsedEvent of parseSSE(upstreamResponse.body!)) {
          const queue: SSEChunk[] = []
          handleParsedUpstreamEvent(parsedEvent, accumulator, queue, state)
          for (const chunk of queue) {
            enqueueSSE(controller, encoder, chunk)
          }
        }

        if (!accumulator.upstreamResponse) {
          const fallback: UpstreamResponse = {
            id: `resp_${randomUUID()}`,
            status: 'completed',
            output: [],
            usage: {
              input_tokens: 0,
              output_tokens: 0,
            },
          }
          const queue: SSEChunk[] = []
          finalizeStreamFromResponse(accumulator, queue, fallback, state)
          for (const chunk of queue) {
            enqueueSSE(controller, encoder, chunk)
          }
        }

        controller.close()
      } catch (error) {
        enqueueSSE(controller, encoder, {
          event: 'error',
          data: {
            type: 'error',
            error: {
              type: 'api_error',
              message:
                error instanceof Error ? error.message : 'Unknown streaming error',
            },
          },
        })
        controller.close()
      }
    },
  })

  return {
    response: new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    }),
    upstreamStatus: upstreamResponse.status,
    error: null,
  }
}

async function handleMessagesRequest(
  request: Request,
  config: ProxyConfig,
  state: ProxyStateStore,
): Promise<MessagesRequestResult> {
  let anthropicRequest: AnthropicMessagesRequest
  try {
    anthropicRequest = (await request.json()) as AnthropicMessagesRequest
  } catch {
    const message = 'Invalid JSON body'
    return {
      response: errorResponse(400, message, 'invalid_request_error'),
      model: null,
      stream: null,
      upstreamStatus: null,
      error: message,
    }
  }

  const model = typeof anthropicRequest?.model === 'string' ? anthropicRequest.model : null
  const stream = Boolean(anthropicRequest?.stream)

  if (!anthropicRequest?.model || !Array.isArray(anthropicRequest?.messages)) {
    const message = 'Missing required model or messages field'
    return {
      response: errorResponse(400, message, 'invalid_request_error'),
      model,
      stream,
      upstreamStatus: null,
      error: message,
    }
  }

  const result = anthropicRequest.stream
    ? await handleStreamingMessagesRequest(config, state, anthropicRequest)
    : await handleNonStreamingMessagesRequest(config, state, anthropicRequest)

  return {
    ...result,
    model,
    stream,
  }
}

export function startOpenAIResponsesCompatProxy(
  config: ProxyConfig,
): RunningOpenAIResponsesCompatProxy {
  const host = config.listenHost ?? '127.0.0.1'
  const state = new ProxyStateStore()
  const server = Bun.serve({
    hostname: host,
    port: config.listenPort ?? 4141,
    fetch: async request => {
      const url = new URL(request.url)

      if (request.method === 'GET' && url.pathname === '/health') {
        return jsonResponse({
          ok: true,
          upstream_url: config.upstreamURL,
          upstream_model: config.upstreamModel ?? null,
        })
      }

      if (request.method === 'POST' && url.pathname === '/v1/messages') {
        const startedAt = Date.now()
        const result = await handleMessagesRequest(request, config, state)
        logRequest(config, {
          method: request.method,
          path: url.pathname,
          model: result.model,
          stream: result.stream,
          status: result.response.status,
          upstreamStatus: result.upstreamStatus,
          durationMs: Date.now() - startedAt,
          error: result.error,
        })
        return result.response
      }

      return errorResponse(404, `Unsupported route: ${url.pathname}`, 'not_found_error')
    },
  })
  const port = server.port
  if (!port) {
    throw new Error('Proxy server failed to bind to a port')
  }

  return {
    port,
    host,
    stop: () => server.stop(true),
  }
}
