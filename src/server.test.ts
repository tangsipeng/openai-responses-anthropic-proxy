import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { startOpenAIResponsesCompatProxy } from './server.js'
import type { RunningOpenAIResponsesCompatProxy } from './types.js'

type MockUpstreamRequest = {
  path: string
  body: unknown
  headers: Headers
}

type MockServer = {
  port: number
  requests: MockUpstreamRequest[]
  stop: () => void
}

function createAnthropicClient(baseURL: string): Anthropic {
  return new Anthropic({
    apiKey: 'test-key',
    baseURL,
    maxRetries: 0,
    dangerouslyAllowBrowser: true,
  })
}

async function readJson(request: Request): Promise<unknown> {
  return await request.json()
}

function startMockUpstream(
  handler: (request: Request, requests: MockUpstreamRequest[]) => Promise<Response>,
): MockServer {
  const requests: MockUpstreamRequest[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async request => {
      requests.push({
        path: new URL(request.url).pathname + new URL(request.url).search,
        body: await readJson(request.clone()),
        headers: request.headers,
      })
      return await handler(request, requests)
    },
  })
  const port = server.port
  if (!port) {
    throw new Error('Mock upstream server failed to bind to a port')
  }

  return {
    port,
    requests,
    stop: () => server.stop(true),
  }
}

function sseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const item of events) {
        controller.enqueue(
          encoder.encode(
            `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`,
          ),
        )
      }
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
    },
  })
}

function parseRequestLog(logLines: string[]): Record<string, unknown> {
  const line = logLines.find(entry =>
    entry.startsWith('[openai-responses-proxy] request '),
  )

  expect(line).toBeDefined()
  return JSON.parse(
    line!.slice('[openai-responses-proxy] request '.length),
  ) as Record<string, unknown>
}

describe('OpenAI Responses compatibility proxy', () => {
  let proxy: RunningOpenAIResponsesCompatProxy | null = null
  const mockServers: MockServer[] = []

  beforeEach(() => {
    proxy = null
  })

  afterEach(() => {
    proxy?.stop()
    proxy = null
    for (const server of mockServers.splice(0)) {
      server.stop()
    }
  })

  test('translates a non-streaming text response into Anthropic message format', async () => {
    const logLines: string[] = []
    const upstream = startMockUpstream(async () => {
      return Response.json({
        id: 'resp_text_1',
        status: 'completed',
        model: 'gpt-4.1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hello from upstream' }],
          },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
        },
      })
    })
    mockServers.push(upstream)

    proxy = startOpenAIResponsesCompatProxy({
      listenPort: 0,
      upstreamURL: `http://127.0.0.1:${upstream.port}`,
      upstreamKey: 'upstream-key',
      upstreamModel: 'gpt-4.1',
      logger: line => logLines.push(line),
    })

    const anthropic = createAnthropicClient(`http://127.0.0.1:${proxy.port}`)
    const response = await anthropic.beta.messages.create({
      model: 'claude-sonnet-test',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Say hello' }],
    })

    expect(response.type).toBe('message')
    expect(response.stop_reason).toBe('end_turn')
    expect(response.content).toEqual([
      {
        type: 'text',
        text: 'hello from upstream',
        citations: null,
      },
    ])

    expect(upstream.requests).toHaveLength(1)
    expect(upstream.requests[0]?.path).toBe('/v1/responses')
    expect(upstream.requests[0]?.body).toMatchObject({
      model: 'gpt-4.1',
      input: [{ role: 'user', content: 'Say hello' }],
      stream: false,
    })

    const logEntry = parseRequestLog(logLines)
    expect(logEntry).toMatchObject({
      method: 'POST',
      path: '/v1/messages',
      model: 'claude-sonnet-test',
      stream: false,
      status: 200,
      upstream_status: 200,
      error: null,
    })
    expect(typeof logEntry.ts).toBe('string')
    expect(typeof logEntry.duration_ms).toBe('number')
    expect(JSON.stringify(logEntry)).not.toContain('Say hello')
  })

  test('uses /v1/responses when upstream URL already includes /v1', async () => {
    const upstream = startMockUpstream(async request => {
      const pathname = new URL(request.url).pathname
      if (pathname !== '/v1/responses') {
        return Response.json(
          {
            error: {
              message: `unexpected path: ${pathname}`,
            },
          },
          { status: 404 },
        )
      }

      return Response.json({
        id: 'resp_text_v1',
        status: 'completed',
        model: 'gpt-4.1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'path ok' }],
          },
        ],
        usage: {
          input_tokens: 3,
          output_tokens: 2,
        },
      })
    })
    mockServers.push(upstream)

    proxy = startOpenAIResponsesCompatProxy({
      listenPort: 0,
      upstreamURL: `http://127.0.0.1:${upstream.port}/v1`,
      upstreamKey: 'upstream-key',
      upstreamModel: 'gpt-4.1',
    })

    const anthropic = createAnthropicClient(`http://127.0.0.1:${proxy.port}`)
    const response = await anthropic.beta.messages.create({
      model: 'claude-sonnet-test',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Say hello' }],
    })

    expect(response.content).toEqual([
      {
        type: 'text',
        text: 'path ok',
        citations: null,
      },
    ])
    expect(upstream.requests[0]?.path).toBe('/v1/responses')
  })

  test('translates upstream function calls into Anthropic tool_use blocks', async () => {
    const upstream = startMockUpstream(async () => {
      return Response.json({
        id: 'resp_tool_1',
        status: 'completed',
        model: 'gpt-4.1',
        output: [
          {
            type: 'function_call',
            call_id: 'call_calc_1',
            name: 'calculator',
            arguments: '{"expression":"2+2"}',
          },
        ],
        usage: {
          input_tokens: 21,
          output_tokens: 3,
        },
      })
    })
    mockServers.push(upstream)

    proxy = startOpenAIResponsesCompatProxy({
      listenPort: 0,
      upstreamURL: `http://127.0.0.1:${upstream.port}`,
      upstreamKey: 'upstream-key',
      upstreamModel: 'gpt-4.1',
    })

    const anthropic = createAnthropicClient(`http://127.0.0.1:${proxy.port}`)
    const response = await anthropic.beta.messages.create({
      model: 'claude-sonnet-test',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'What is 2 + 2?' }],
      tools: [
        {
          name: 'calculator',
          description: 'Evaluate a math expression',
          input_schema: {
            type: 'object',
            properties: {
              expression: { type: 'string' },
            },
            required: ['expression'],
          },
        },
      ],
    })

    expect(response.stop_reason).toBe('tool_use')
    expect(response.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_calc_1',
        name: 'calculator',
        input: { expression: '2+2' },
      },
    ])

    expect(upstream.requests[0]?.body).toMatchObject({
      tools: [
        {
          type: 'function',
          name: 'calculator',
          description: 'Evaluate a math expression',
          parameters: {
            type: 'object',
            properties: {
              expression: { type: 'string' },
            },
            required: ['expression'],
          },
        },
      ],
    })
  })

  test('uses previous_response_id and function_call_output on the next turn when state is available', async () => {
    const upstream = startMockUpstream(async (_request, requests) => {
      if (requests.length === 1) {
        return Response.json({
          id: 'resp_chain_1',
          status: 'completed',
          model: 'gpt-4.1',
          output: [
            {
              type: 'function_call',
              call_id: 'call_calc_1',
              name: 'calculator',
              arguments: '{"expression":"2+2"}',
            },
          ],
          usage: {
            input_tokens: 8,
            output_tokens: 2,
          },
        })
      }

      return Response.json({
        id: 'resp_chain_2',
        status: 'completed',
        model: 'gpt-4.1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'The answer is 4.' }],
          },
        ],
        usage: {
          input_tokens: 4,
          output_tokens: 5,
        },
      })
    })
    mockServers.push(upstream)

    proxy = startOpenAIResponsesCompatProxy({
      listenPort: 0,
      upstreamURL: `http://127.0.0.1:${upstream.port}`,
      upstreamKey: 'upstream-key',
      upstreamModel: 'gpt-4.1',
    })

    const anthropic = createAnthropicClient(`http://127.0.0.1:${proxy.port}`)

    const first = await anthropic.beta.messages.create({
      model: 'claude-sonnet-test',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Use the calculator for 2+2' }],
      tools: [
        {
          name: 'calculator',
          description: 'Evaluate a math expression',
          input_schema: {
            type: 'object',
            properties: {
              expression: { type: 'string' },
            },
            required: ['expression'],
          },
        },
      ],
    })

    expect(first.content[0]).toEqual({
      type: 'tool_use',
      id: 'call_calc_1',
      name: 'calculator',
      input: { expression: '2+2' },
    })

    const second = await anthropic.beta.messages.create({
      model: 'claude-sonnet-test',
      max_tokens: 128,
      messages: [
        { role: 'user', content: 'Use the calculator for 2+2' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_calc_1',
              name: 'calculator',
              input: { expression: '2+2' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_calc_1',
              content: '4',
            },
          ],
        },
      ],
      tools: [
        {
          name: 'calculator',
          description: 'Evaluate a math expression',
          input_schema: {
            type: 'object',
            properties: {
              expression: { type: 'string' },
            },
            required: ['expression'],
          },
        },
      ],
    })

    expect(second.content).toEqual([
      {
        type: 'text',
        text: 'The answer is 4.',
        citations: null,
      },
    ])

    expect(upstream.requests).toHaveLength(2)
    expect(upstream.requests[1]?.body).toMatchObject({
      previous_response_id: 'resp_chain_1',
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_calc_1',
          output: '4',
        },
      ],
    })
  })

  test('emits Anthropic-compatible SSE events for streaming text', async () => {
    const logLines: string[] = []
    const upstream = startMockUpstream(async () => {
      return sseResponse([
        {
          event: 'response.output_text.delta',
          data: {
            type: 'response.output_text.delta',
            delta: 'Hello',
          },
        },
        {
          event: 'response.output_text.delta',
          data: {
            type: 'response.output_text.delta',
            delta: ' world',
          },
        },
        {
          event: 'response.completed',
          data: {
            type: 'response.completed',
            response: {
              id: 'resp_stream_1',
              status: 'completed',
              model: 'gpt-4.1',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'Hello world' }],
                },
              ],
              usage: {
                input_tokens: 5,
                output_tokens: 2,
              },
            },
          },
        },
      ])
    })
    mockServers.push(upstream)

    proxy = startOpenAIResponsesCompatProxy({
      listenPort: 0,
      upstreamURL: `http://127.0.0.1:${upstream.port}`,
      upstreamKey: 'upstream-key',
      upstreamModel: 'gpt-4.1',
      logger: line => logLines.push(line),
    })

    const anthropic = createAnthropicClient(`http://127.0.0.1:${proxy.port}`)
    const stream = await anthropic.beta.messages.create({
      model: 'claude-sonnet-test',
      max_tokens: 128,
      stream: true,
      messages: [{ role: 'user', content: 'Say hello' }],
    })

    const events: Array<{ type: string; deltaType?: string }> = []
    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        events.push({ type: event.type, deltaType: event.delta.type })
      } else {
        events.push({ type: event.type })
      }
    }

    expect(events).toEqual([
      { type: 'message_start' },
      { type: 'content_block_start' },
      { type: 'content_block_delta', deltaType: 'text_delta' },
      { type: 'content_block_delta', deltaType: 'text_delta' },
      { type: 'content_block_stop' },
      { type: 'message_delta' },
      { type: 'message_stop' },
    ])

    const logEntry = parseRequestLog(logLines)
    expect(logEntry).toMatchObject({
      method: 'POST',
      path: '/v1/messages',
      model: 'claude-sonnet-test',
      stream: true,
      status: 200,
      upstream_status: 200,
      error: null,
    })
  })

  test('returns JSON error when upstream responds 200 with an empty body', async () => {
    const upstream = startMockUpstream(async () => {
      return new Response(null, {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      })
    })
    mockServers.push(upstream)

    proxy = startOpenAIResponsesCompatProxy({
      listenPort: 0,
      upstreamURL: `http://127.0.0.1:${upstream.port}/v1`,
      upstreamKey: 'upstream-key',
      upstreamModel: 'gpt-4.1',
    })

    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-test',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'reply with exactly OK' }],
      }),
    })

    expect(response.status).toBe(502)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'Upstream returned an invalid response payload',
      },
    })
  })
})
