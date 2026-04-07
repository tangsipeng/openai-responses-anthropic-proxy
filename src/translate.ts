import { randomUUID } from 'crypto'
import { ProxyStateStore } from './state.js'
import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicMessageParam,
  AnthropicMessageResponse,
  AnthropicMessagesRequest,
  AnthropicTextBlock,
  AnthropicToolChoice,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicUsage,
  UpstreamFunctionCallItem,
  UpstreamFunctionTool,
  UpstreamInputItem,
  UpstreamMessageContentItem,
  UpstreamResponse,
  UpstreamResponseOutputItem,
  UpstreamResponsesRequest,
} from './types.js'

function isUpstreamFunctionCallItem(
  item: UpstreamResponseOutputItem,
): item is UpstreamFunctionCallItem {
  return (
    item.type === 'function_call' &&
    typeof item.call_id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.arguments === 'string'
  )
}

function isUpstreamReasoningItem(
  item: UpstreamResponseOutputItem,
): item is Extract<UpstreamResponseOutputItem, { type: 'reasoning' }> {
  return item.type === 'reasoning'
}

function normalizeAnthropicContent(
  content: AnthropicMessageParam['content'],
): AnthropicContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content, citations: null }]
  }
  return content
}

function normalizeSystemText(system: AnthropicMessagesRequest['system']): string | undefined {
  if (!system) return undefined
  if (typeof system === 'string') return system
  const text = system
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n\n')
    .trim()
  return text || undefined
}

function resolveReasoningEffort(
  request: AnthropicMessagesRequest,
): UpstreamResponsesRequest['reasoning'] | undefined {
  const configuredEffort =
    request.output_config &&
    typeof request.output_config === 'object' &&
    !Array.isArray(request.output_config) &&
    'effort' in request.output_config
      ? request.output_config.effort
      : undefined

  if (configuredEffort === 'low' || configuredEffort === 'medium' || configuredEffort === 'high') {
    return { effort: configuredEffort }
  }

  if (configuredEffort === 'max') {
    return { effort: 'xhigh' }
  }

  const thinking = request.thinking
  if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) {
    return undefined
  }

  const type = 'type' in thinking ? thinking.type : undefined
  const budgetTokens =
    'budget_tokens' in thinking && typeof thinking.budget_tokens === 'number'
      ? thinking.budget_tokens
      : undefined

  if (type === 'adaptive') {
    return { effort: 'high' }
  }

  if (type === 'enabled') {
    if (typeof budgetTokens === 'number') {
      if (budgetTokens < 4000) return { effort: 'low' }
      if (budgetTokens < 16000) return { effort: 'medium' }
    }
    return { effort: 'high' }
  }

  return undefined
}

function imageBlockToInputImage(block: AnthropicImageBlock): UpstreamMessageContentItem {
  if (block.source.type === 'url') {
    return {
      type: 'input_image',
      image_url: block.source.url,
    }
  }

  return {
    type: 'input_image',
    image_url: `data:${block.source.media_type};base64,${block.source.data}`,
  }
}

function blockArrayToMessageContent(
  blocks: AnthropicContentBlock[],
): string | UpstreamMessageContentItem[] | null {
  const items: UpstreamMessageContentItem[] = []

  for (const block of blocks) {
    if (block.type === 'text') {
      items.push({ type: 'input_text', text: block.text })
      continue
    }
    if (block.type === 'image') {
      items.push(imageBlockToInputImage(block))
    }
  }

  if (items.length === 0) {
    return null
  }

  if (items.every(item => item.type === 'input_text')) {
    return items.map(item => (item as { text: string }).text).join('\n')
  }

  return items
}

function toolResultContentToString(
  block: AnthropicToolResultBlock,
): string {
  if (typeof block.content === 'string') {
    return block.content
  }

  if (!Array.isArray(block.content)) {
    return block.is_error ? 'error' : ''
  }

  const normalized = block.content.map(item => {
    if (item.type === 'text') {
      return item.text
    }
    if (item.type === 'image') {
      return item.source.type === 'url'
        ? item.source.url
        : `data:${item.source.media_type};base64,${item.source.data}`
    }
    return JSON.stringify(item)
  })

  return normalized.join('\n')
}

function assistantTextFromBlocks(blocks: AnthropicContentBlock[]): string | null {
  const text = blocks
    .filter((block): block is AnthropicTextBlock => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
  return text || null
}

function messageToUpstreamItems(message: AnthropicMessageParam): UpstreamInputItem[] {
  const blocks = normalizeAnthropicContent(message.content)
  const items: UpstreamInputItem[] = []

  if (message.role === 'assistant') {
    const assistantText = assistantTextFromBlocks(blocks)
    if (assistantText) {
      items.push({
        role: 'assistant',
        content: assistantText,
      })
    }

    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      items.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      })
    }

    return items
  }

  const messageContent = blockArrayToMessageContent(blocks)
  if (messageContent) {
    items.push({
      role: 'user',
      content: messageContent,
    })
  }

  for (const block of blocks) {
    if (block.type !== 'tool_result') continue
    items.push({
      type: 'function_call_output',
      call_id: block.tool_use_id,
      output: toolResultContentToString(block),
    })
  }

  return items
}

function convertTools(
  tools: AnthropicMessagesRequest['tools'],
): UpstreamFunctionTool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined
  }

  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.input_schema ? { parameters: tool.input_schema } : {}),
  }))
}

function convertToolChoice(
  toolChoice: AnthropicToolChoice | undefined,
): {
  tool_choice?: UpstreamResponsesRequest['tool_choice']
  parallel_tool_calls?: boolean
} {
  if (!toolChoice) {
    return {}
  }

  const disableParallel = Boolean(toolChoice.disable_parallel_tool_use)
  const parallel_tool_calls = disableParallel ? false : undefined

  switch (toolChoice.type) {
    case 'none':
      return { tool_choice: 'none', parallel_tool_calls }
    case 'auto':
      return { tool_choice: 'auto', parallel_tool_calls }
    case 'any':
      return { tool_choice: 'required', parallel_tool_calls }
    case 'tool':
      return {
        tool_choice: {
          type: 'function',
          name: toolChoice.name,
        },
        parallel_tool_calls,
      }
    default:
      return { parallel_tool_calls }
  }
}

function normalizeUpstreamOutputText(items: UpstreamResponseOutputItem[]): string {
  const parts: string[] = []
  for (const item of items) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const content of item.content) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text)
      }
    }
  }
  return parts.join('')
}

function parseToolCall(item: UpstreamFunctionCallItem): AnthropicToolUseBlock {
  let input: unknown = {}
  try {
    input = item.arguments ? JSON.parse(item.arguments) : {}
  } catch {
    input = {}
  }

  return {
    type: 'tool_use',
    id: item.call_id,
    name: item.name,
    input,
  }
}

function parseReasoningText(item: Extract<UpstreamResponseOutputItem, { type: 'reasoning' }>): string | null {
  if (!Array.isArray(item.summary)) {
    return null
  }

  const text = item.summary
    .map(part => {
      if (!part || typeof part !== 'object') {
        return ''
      }
      if (part.type && part.type !== 'summary_text') {
        return ''
      }
      return typeof part.text === 'string' ? part.text : ''
    })
    .join('')
    .trim()

  return text || null
}

function mapUsage(response: UpstreamResponse): AnthropicUsage {
  const inputTokens = response.usage?.input_tokens ?? 0
  const outputTokens = response.usage?.output_tokens ?? 0
  const cacheReadInputTokens =
    response.usage?.cache_read_input_tokens ??
    response.usage?.input_tokens_details?.cached_tokens ??
    response.usage?.prompt_tokens_details?.cached_tokens ??
    null

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: response.usage?.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: cacheReadInputTokens,
  }
}

function inferStopReason(
  response: UpstreamResponse,
  content: AnthropicMessageResponse['content'],
): AnthropicMessageResponse['stop_reason'] {
  if (content.some(block => block.type === 'tool_use')) {
    return 'tool_use'
  }

  if (
    response.status === 'incomplete' &&
    (response.incomplete_details?.reason === 'max_output_tokens' ||
      response.incomplete_details?.reason === 'max_tokens' ||
      response.incomplete_details?.reason === undefined)
  ) {
    return 'max_tokens'
  }

  return 'end_turn'
}

export function translateUpstreamResponseToAnthropicMessage(
  response: UpstreamResponse,
  requestedModel: string,
): AnthropicMessageResponse {
  const output = Array.isArray(response.output) ? response.output : []
  const content: AnthropicMessageResponse['content'] = []

  for (const item of output) {
    if (isUpstreamFunctionCallItem(item)) {
      content.push(parseToolCall(item))
      continue
    }

    if (isUpstreamReasoningItem(item)) {
      const thinking = parseReasoningText(item)
      if (thinking) {
        content.push({
          type: 'thinking',
          thinking,
        })
      }
      continue
    }

    if (item.type !== 'message') {
      continue
    }

    if (!Array.isArray(item.content)) {
      continue
    }

    const text = item.content
      .map(part => {
        if (part?.type === 'output_text' && typeof part.text === 'string') {
          return part.text
        }
        if (part?.type === 'refusal' && typeof part.refusal === 'string') {
          return part.refusal
        }
        return ''
      })
      .join('')

    if (!text) continue

    content.push({
      type: 'text',
      text,
      citations: null,
    })
  }

  if (content.length === 0 && response.output_text) {
    content.push({
      type: 'text',
      text: response.output_text,
      citations: null,
    })
  }

  if (content.length === 0) {
    const fallbackText = normalizeUpstreamOutputText(output)
    if (fallbackText) {
      content.push({
        type: 'text',
        text: fallbackText,
        citations: null,
      })
    }
  }

  return {
    id: response.id || `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: requestedModel,
    stop_reason: inferStopReason(response, content),
    stop_sequence: null,
    usage: mapUsage(response),
  }
}

export function translateAnthropicRequestToUpstream(
  request: AnthropicMessagesRequest,
  upstreamModel: string,
  state: ProxyStateStore,
): {
  body: UpstreamResponsesRequest
  mode: 'full' | 'incremental'
} {
  const previous = state.findPreviousResponseId(request.messages)
  const instructions = normalizeSystemText(request.system)
  const tools = convertTools(request.tools)
  const toolChoice = convertToolChoice(request.tool_choice)
  const reasoning = resolveReasoningEffort(request)

  const messagesToTranslate =
    previous && previous.assistantIndex >= 0
      ? request.messages.slice(previous.assistantIndex + 1)
      : request.messages

  const input = messagesToTranslate.flatMap(messageToUpstreamItems)

  return {
    mode: previous ? 'incremental' : 'full',
    body: {
      model: upstreamModel,
      input,
      ...(instructions ? { instructions } : {}),
      ...(tools ? { tools } : {}),
      ...(toolChoice.tool_choice ? { tool_choice: toolChoice.tool_choice } : {}),
      ...(toolChoice.parallel_tool_calls !== undefined
        ? { parallel_tool_calls: toolChoice.parallel_tool_calls }
        : {}),
      ...(reasoning ? { reasoning } : {}),
      max_output_tokens: request.max_tokens,
      ...(previous ? { previous_response_id: previous.responseId } : {}),
      stream: Boolean(request.stream),
    },
  }
}
