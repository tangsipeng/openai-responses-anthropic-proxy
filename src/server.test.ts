import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
  const tempDirs: string[] = []

  beforeEach(() => {
    proxy = null
  })

  afterEach(() => {
    proxy?.stop()
    proxy = null
    for (const server of mockServers.splice(0)) {
      server.stop()
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
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
    expect(logEntry.ts).toMatch(/[+-]\d{2}:\d{2}$/)
    expect(logEntry.ts).not.toMatch(/Z$/)
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

  test('maps reasoning summaries and refusals into Anthropic-compatible content blocks', async () => {
    const upstream = startMockUpstream(async () => {
      return Response.json({
        id: 'resp_reasoning_refusal_1',
        status: 'completed',
        model: 'gpt-4.1',
        output: [
          {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'I should decline this request.' }],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'refusal', refusal: 'I can’t help with that.' }],
          },
        ],
        usage: {
          input_tokens: 12,
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
    const response = await anthropic.beta.messages.create({
      model: 'claude-sonnet-test',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Do something disallowed' }],
    })

    expect(response.stop_reason).toBe('end_turn')
    expect(response.content as any).toEqual([
      {
        type: 'thinking',
        thinking: 'I should decline this request.',
      },
      {
        type: 'text',
        text: 'I can’t help with that.',
        citations: null,
      },
    ])
  })

  test('maps usage cache token fields from nested usage details', async () => {
    const upstream = startMockUpstream(async () => {
      return Response.json({
        id: 'resp_usage_nested_1',
        status: 'completed',
        model: 'gpt-4.1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'cached response' }],
          },
        ],
        usage: {
          input_tokens: 17,
          output_tokens: 6,
          input_tokens_details: {
            cached_tokens: 9,
          },
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
      messages: [{ role: 'user', content: 'Say cached response' }],
    })

    expect(response.usage).toEqual({
      input_tokens: 17,
      output_tokens: 6,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: 9,
    })
  })

  test('prefers direct cache usage fields over prompt-token fallbacks', async () => {
    const upstream = startMockUpstream(async () => {
      return Response.json({
        id: 'resp_usage_direct_1',
        status: 'completed',
        model: 'gpt-4.1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'direct cache response' }],
          },
        ],
        usage: {
          input_tokens: 19,
          output_tokens: 4,
          prompt_tokens_details: {
            cached_tokens: 5,
          },
          cache_read_input_tokens: 11,
          cache_creation_input_tokens: 3,
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
      messages: [{ role: 'user', content: 'Say direct cache response' }],
    })

    expect(response.usage).toEqual({
      input_tokens: 19,
      output_tokens: 4,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 11,
    })
  })

  test('maps Anthropic reasoning controls to upstream reasoning effort', async () => {
    const upstream = startMockUpstream(async () => {
      return Response.json({
        id: 'resp_reasoning_request_1',
        status: 'completed',
        model: 'gpt-4.1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: {
          input_tokens: 2,
          output_tokens: 1,
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

    const firstResponse = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'test-key',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-test',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Reply with ok' }],
        output_config: { effort: 'max' },
      }),
    })
    expect(firstResponse.status).toBe(200)
    await firstResponse.json()

    const secondResponse = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'test-key',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-test',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Reply with ok again' }],
        thinking: { type: 'enabled', budget_tokens: 8000 },
      }),
    })
    expect(secondResponse.status).toBe(200)
    await secondResponse.json()

    expect(upstream.requests[0]?.body).toMatchObject({
      reasoning: { effort: 'xhigh' },
    })
    expect(upstream.requests[1]?.body).toMatchObject({
      reasoning: { effort: 'medium' },
    })
  })

  test('maps incomplete max-token responses to Anthropic max_tokens stop reason', async () => {
    const upstream = startMockUpstream(async (_request, requests) => {
      if (requests.length === 1) {
        return Response.json({
          id: 'resp_incomplete_1',
          status: 'incomplete',
          model: 'gpt-4.1',
          incomplete_details: {
            reason: 'max_tokens',
          },
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'partial one' }],
            },
          ],
          usage: {
            input_tokens: 3,
            output_tokens: 2,
          },
        })
      }

      return Response.json({
        id: 'resp_incomplete_2',
        status: 'incomplete',
        model: 'gpt-4.1',
        incomplete_details: {
          reason: 'max_output_tokens',
        },
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'partial two' }],
          },
        ],
        usage: {
          input_tokens: 4,
          output_tokens: 2,
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
      messages: [{ role: 'user', content: 'Give me a long answer' }],
    })
    const second = await anthropic.beta.messages.create({
      model: 'claude-sonnet-test',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Give me another long answer' }],
    })

    expect(first.stop_reason).toBe('max_tokens')
    expect(second.stop_reason).toBe('max_tokens')
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

  test('restores previous_response_id after the proxy restarts when a state file is configured', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'openai-responses-proxy-'))
    tempDirs.push(stateDir)
    const stateFilePath = join(stateDir, 'proxy-state.json')

    const upstream = startMockUpstream(async (_request, requests) => {
      if (requests.length === 1) {
        return Response.json({
          id: 'resp_restart_1',
          status: 'completed',
          model: 'gpt-4.1',
          output: [
            {
              type: 'function_call',
              call_id: 'call_calc_restart_1',
              name: 'calculator',
              arguments: '{"expression":"3+4"}',
            },
          ],
          usage: {
            input_tokens: 8,
            output_tokens: 2,
          },
        })
      }

      const secondBody = requests[1]?.body as Record<string, unknown> | undefined
      if (secondBody?.previous_response_id !== 'resp_restart_1') {
        return Response.json(
          {
            error: {
              message:
                'No tool call found for function call output with call_id call_calc_restart_1.',
            },
          },
          { status: 400 },
        )
      }

      return Response.json({
        id: 'resp_restart_2',
        status: 'completed',
        model: 'gpt-4.1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'The answer is 7.' }],
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
      stateFilePath,
    })

    const firstClient = createAnthropicClient(`http://127.0.0.1:${proxy.port}`)
    const first = await firstClient.beta.messages.create({
      model: 'claude-sonnet-test',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Use the calculator for 3+4' }],
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
      id: 'call_calc_restart_1',
      name: 'calculator',
      input: { expression: '3+4' },
    })

    proxy.stop()
    proxy = startOpenAIResponsesCompatProxy({
      listenPort: 0,
      upstreamURL: `http://127.0.0.1:${upstream.port}`,
      upstreamKey: 'upstream-key',
      upstreamModel: 'gpt-4.1',
      stateFilePath,
    })

    const secondClient = createAnthropicClient(`http://127.0.0.1:${proxy.port}`)
    const second = await secondClient.beta.messages.create({
      model: 'claude-sonnet-test',
      max_tokens: 128,
      messages: [
        { role: 'user', content: 'Use the calculator for 3+4' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_calc_restart_1',
              name: 'calculator',
              input: { expression: '3+4' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_calc_restart_1',
              content: '7',
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
        text: 'The answer is 7.',
        citations: null,
      },
    ])

    expect(upstream.requests).toHaveLength(2)
    expect(upstream.requests[1]?.body).toMatchObject({
      previous_response_id: 'resp_restart_1',
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_calc_restart_1',
          output: '7',
        },
      ],
    })
  })

  test('uses previous_response_id when Claude splits a multi-tool assistant turn into consecutive assistant messages', async () => {
    const upstream = startMockUpstream(async (_request, requests) => {
      if (requests.length === 1) {
        return Response.json({
          id: 'resp_multi_1',
          status: 'completed',
          model: 'gpt-4.1',
          output: [
            {
              type: 'function_call',
              call_id: 'call_task_1',
              name: 'TaskCreate',
              arguments:
                '{"subject":"Inspect repository structure","activeForm":"Inspecting repository structure"}',
            },
            {
              type: 'function_call',
              call_id: 'call_glob_1',
              name: 'Glob',
              arguments: '{"path":".","pattern":"src/**/*"}',
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 4,
          },
        })
      }

      const secondBody = requests[1]?.body as Record<string, unknown> | undefined
      if (secondBody?.previous_response_id !== 'resp_multi_1') {
        return Response.json(
          {
            error: {
              message:
                'No tool call found for function call output with call_id call_task_1.',
            },
          },
          { status: 400 },
        )
      }

      return Response.json({
        id: 'resp_multi_2',
        status: 'completed',
        model: 'gpt-4.1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Repository inspection started.' }],
          },
        ],
        usage: {
          input_tokens: 5,
          output_tokens: 4,
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
      messages: [{ role: 'user', content: 'Analyze this project structure' }],
      tools: [
        {
          name: 'TaskCreate',
          description: 'Create a task',
          input_schema: {
            type: 'object',
            properties: {
              subject: { type: 'string' },
              activeForm: { type: 'string' },
            },
            required: ['subject'],
          },
        },
        {
          name: 'Glob',
          description: 'Find files',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              pattern: { type: 'string' },
            },
            required: ['path', 'pattern'],
          },
        },
      ],
    })

    expect(first.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_task_1',
        name: 'TaskCreate',
        input: {
          subject: 'Inspect repository structure',
          activeForm: 'Inspecting repository structure',
        },
      },
      {
        type: 'tool_use',
        id: 'call_glob_1',
        name: 'Glob',
        input: {
          path: '.',
          pattern: 'src/**/*',
        },
      },
    ])

    const second = await anthropic.beta.messages.create({
      model: 'claude-sonnet-test',
      max_tokens: 128,
      messages: [
        { role: 'user', content: 'Analyze this project structure' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_task_1',
              name: 'TaskCreate',
              input: {
                subject: 'Inspect repository structure',
                activeForm: 'Inspecting repository structure',
              },
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_glob_1',
              name: 'Glob',
              input: {
                path: '.',
                pattern: 'src/**/*',
              },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_task_1',
              content: 'Task #1 created successfully: Inspect repository structure',
            },
          ],
        },
      ],
      tools: [
        {
          name: 'TaskCreate',
          description: 'Create a task',
          input_schema: {
            type: 'object',
            properties: {
              subject: { type: 'string' },
              activeForm: { type: 'string' },
            },
            required: ['subject'],
          },
        },
        {
          name: 'Glob',
          description: 'Find files',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              pattern: { type: 'string' },
            },
            required: ['path', 'pattern'],
          },
        },
      ],
    })

    expect(second.content).toEqual([
      {
        type: 'text',
        text: 'Repository inspection started.',
        citations: null,
      },
    ])

    expect(upstream.requests).toHaveLength(2)
    expect(upstream.requests[1]?.body).toMatchObject({
      previous_response_id: 'resp_multi_1',
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_task_1',
          output: 'Task #1 created successfully: Inspect repository structure',
        },
      ],
    })
  })

  test('falls back to full replay when the upstream rejects previous_response_id tool continuation', async () => {
    const upstream = startMockUpstream(async (_request, requests) => {
      if (requests.length === 1) {
        return Response.json({
          id: 'resp_fallback_1',
          status: 'completed',
          model: 'gpt-4.1',
          output: [
            {
              type: 'function_call',
              call_id: 'call_todo_1',
              name: 'TodoWrite',
              arguments:
                '{"todos":[{"content":"Analyze the repository structure","status":"in_progress","activeForm":"Analyzing the repository structure"}]}',
            },
          ],
          usage: {
            input_tokens: 9,
            output_tokens: 3,
          },
        })
      }

      if (requests.length === 2) {
        return Response.json(
          {
            error: {
              message:
                'No tool call found for function call output with call_id call_todo_1.',
            },
          },
          { status: 400 },
        )
      }

      return Response.json({
        id: 'resp_fallback_2',
        status: 'completed',
        model: 'gpt-4.1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'I can now continue after the todo update.',
              },
            ],
          },
        ],
        usage: {
          input_tokens: 7,
          output_tokens: 6,
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
      messages: [{ role: 'user', content: 'Analyze this project structure' }],
      tools: [
        {
          name: 'TodoWrite',
          description: 'Update todos',
          input_schema: {
            type: 'object',
            properties: {
              todos: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    content: { type: 'string' },
                    status: { type: 'string' },
                    activeForm: { type: 'string' },
                  },
                  required: ['content', 'status'],
                },
              },
            },
            required: ['todos'],
          },
        },
      ],
    })

    expect(first.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_todo_1',
        name: 'TodoWrite',
        input: {
          todos: [
            {
              content: 'Analyze the repository structure',
              status: 'in_progress',
              activeForm: 'Analyzing the repository structure',
            },
          ],
        },
      },
    ])

    const stream = await anthropic.beta.messages.create({
      model: 'claude-sonnet-test',
      max_tokens: 128,
      stream: true,
      messages: [
        { role: 'user', content: 'Analyze this project structure' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_todo_1',
              name: 'TodoWrite',
              input: {
                todos: [
                  {
                    content: 'Analyze the repository structure',
                    status: 'in_progress',
                    activeForm: 'Analyzing the repository structure',
                  },
                ],
              },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_todo_1',
              content:
                'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress.',
            },
          ],
        },
      ],
      tools: [
        {
          name: 'TodoWrite',
          description: 'Update todos',
          input_schema: {
            type: 'object',
            properties: {
              todos: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    content: { type: 'string' },
                    status: { type: 'string' },
                    activeForm: { type: 'string' },
                  },
                  required: ['content', 'status'],
                },
              },
            },
            required: ['todos'],
          },
        },
      ],
    })

    let text = ''
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text
      }
    }

    expect(text).toContain('I can now continue after the todo update.')

    expect(upstream.requests).toHaveLength(3)
    expect(upstream.requests[1]?.body).toMatchObject({
      previous_response_id: 'resp_fallback_1',
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_todo_1',
          output:
            'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress.',
        },
      ],
    })
    expect(upstream.requests[2]?.body).not.toHaveProperty('previous_response_id')
    expect(upstream.requests[2]?.body).toMatchObject({
      input: [
        {
          role: 'user',
          content: 'Analyze this project structure',
        },
        {
          type: 'function_call',
          call_id: 'call_todo_1',
          name: 'TodoWrite',
          arguments:
            '{"todos":[{"content":"Analyze the repository structure","status":"in_progress","activeForm":"Analyzing the repository structure"}]}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_todo_1',
          output:
            'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress.',
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

  test('emits thinking deltas for streaming reasoning events without duplicating finalized content', async () => {
    const upstream = startMockUpstream(async () => {
      return sseResponse([
        {
          event: 'response.reasoning.delta',
          data: {
            type: 'response.reasoning.delta',
            delta: 'Thinking step',
          },
        },
        {
          event: 'response.reasoning.done',
          data: {
            type: 'response.reasoning.done',
          },
        },
        {
          event: 'response.completed',
          data: {
            type: 'response.completed',
            response: {
              id: 'resp_reasoning_stream_1',
              status: 'completed',
              model: 'gpt-4.1',
              output: [
                {
                  type: 'reasoning',
                  summary: [{ type: 'summary_text', text: 'Thinking step' }],
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
    })

    const anthropic = createAnthropicClient(`http://127.0.0.1:${proxy.port}`)
    const stream = await anthropic.beta.messages.create({
      model: 'claude-sonnet-test',
      max_tokens: 128,
      stream: true,
      messages: [{ role: 'user', content: 'Think first' }],
    })

    const events: Array<{
      type: string
      deltaType?: string
      contentBlockType?: string
    }> = []

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        events.push({
          type: event.type,
          contentBlockType: event.content_block.type,
        })
        continue
      }

      if (event.type === 'content_block_delta') {
        events.push({ type: event.type, deltaType: event.delta.type })
        continue
      }

      events.push({ type: event.type })
    }

    expect(events).toEqual([
      { type: 'message_start' },
      { type: 'content_block_start', contentBlockType: 'thinking' },
      { type: 'content_block_delta', deltaType: 'thinking_delta' },
      { type: 'content_block_stop' },
      { type: 'message_delta' },
      { type: 'message_stop' },
    ])
  })

  test('emits text deltas for streaming refusal events without duplicating finalized content', async () => {
    const upstream = startMockUpstream(async () => {
      return sseResponse([
        {
          event: 'response.refusal.delta',
          data: {
            type: 'response.refusal.delta',
            delta: 'I can’t help with that.',
          },
        },
        {
          event: 'response.refusal.done',
          data: {
            type: 'response.refusal.done',
          },
        },
        {
          event: 'response.completed',
          data: {
            type: 'response.completed',
            response: {
              id: 'resp_refusal_stream_1',
              status: 'completed',
              model: 'gpt-4.1',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'refusal', refusal: 'I can’t help with that.' }],
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
    })

    const anthropic = createAnthropicClient(`http://127.0.0.1:${proxy.port}`)
    const stream = await anthropic.beta.messages.create({
      model: 'claude-sonnet-test',
      max_tokens: 128,
      stream: true,
      messages: [{ role: 'user', content: 'Do something disallowed' }],
    })

    const events: Array<{
      type: string
      deltaType?: string
      contentBlockType?: string
    }> = []

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        events.push({
          type: event.type,
          contentBlockType: event.content_block.type,
        })
        continue
      }

      if (event.type === 'content_block_delta') {
        events.push({ type: event.type, deltaType: event.delta.type })
        continue
      }

      events.push({ type: event.type })
    }

    expect(events).toEqual([
      { type: 'message_start' },
      { type: 'content_block_start', contentBlockType: 'text' },
      { type: 'content_block_delta', deltaType: 'text_delta' },
      { type: 'content_block_stop' },
      { type: 'message_delta' },
      { type: 'message_stop' },
    ])
  })

  test('emits input_json_delta events for streaming tool calls', async () => {
    const upstream = startMockUpstream(async () => {
      return sseResponse([
        {
          event: 'response.output_item.added',
          data: {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              type: 'function_call',
              call_id: 'call_calc_stream_1',
              name: 'calculator',
            },
          },
        },
        {
          event: 'response.function_call_arguments.delta',
          data: {
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            delta: '{"expression":"2+2"}',
          },
        },
        {
          event: 'response.function_call_arguments.done',
          data: {
            type: 'response.function_call_arguments.done',
            output_index: 0,
          },
        },
        {
          event: 'response.completed',
          data: {
            type: 'response.completed',
            response: {
              id: 'resp_tool_stream_1',
              status: 'completed',
              model: 'gpt-4.1',
              output: [
                {
                  type: 'function_call',
                  call_id: 'call_calc_stream_1',
                  name: 'calculator',
                  arguments: '{"expression":"2+2"}',
                },
              ],
              usage: {
                input_tokens: 9,
                output_tokens: 3,
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
    })

    const anthropic = createAnthropicClient(`http://127.0.0.1:${proxy.port}`)
    const stream = await anthropic.beta.messages.create({
      model: 'claude-sonnet-test',
      max_tokens: 128,
      stream: true,
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

    const events: Array<{
      type: string
      deltaType?: string
      contentBlockType?: string
      toolInput?: unknown
    }> = []

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        events.push({
          type: event.type,
          contentBlockType: event.content_block.type,
          ...(event.content_block.type === 'tool_use'
            ? { toolInput: event.content_block.input }
            : {}),
        })
        continue
      }

      if (event.type === 'content_block_delta') {
        events.push({ type: event.type, deltaType: event.delta.type })
        continue
      }

      events.push({ type: event.type })
    }

    expect(events).toEqual([
      { type: 'message_start' },
      {
        type: 'content_block_start',
        contentBlockType: 'tool_use',
        toolInput: {},
      },
      { type: 'content_block_delta', deltaType: 'input_json_delta' },
      { type: 'content_block_stop' },
      { type: 'message_delta' },
      { type: 'message_stop' },
    ])
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
