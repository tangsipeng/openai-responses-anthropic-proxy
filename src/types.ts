export type AnthropicTextBlock = {
  type: 'text'
  text: string
  citations?: null
}

export type AnthropicImageBlock = {
  type: 'image'
  source:
    | {
        type: 'base64'
        media_type: string
        data: string
      }
    | {
        type: 'url'
        url: string
      }
}

export type AnthropicToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export type AnthropicToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content?: string | Array<AnthropicTextBlock | AnthropicImageBlock>
  is_error?: boolean
}

export type AnthropicThinkingBlock = {
  type: 'thinking' | 'redacted_thinking'
  thinking?: string
  data?: string
  signature?: string
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock

export type AnthropicMessageParam = {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export type AnthropicSystemBlock = {
  type: 'text'
  text: string
}

export type AnthropicTool = {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
  [key: string]: unknown
}

export type AnthropicToolChoice =
  | {
      type: 'auto' | 'none'
      disable_parallel_tool_use?: boolean
    }
  | {
      type: 'tool'
      name: string
      disable_parallel_tool_use?: boolean
    }
  | {
      type: 'any'
      disable_parallel_tool_use?: boolean
    }

export type AnthropicMessagesRequest = {
  model: string
  max_tokens: number
  messages: AnthropicMessageParam[]
  system?: string | AnthropicSystemBlock[]
  tools?: AnthropicTool[]
  tool_choice?: AnthropicToolChoice
  stream?: boolean
  thinking?: unknown
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export type AnthropicUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number | null
  cache_read_input_tokens: number | null
}

export type AnthropicMessageResponse = {
  id: string
  type: 'message'
  role: 'assistant'
  content: Array<AnthropicTextBlock | AnthropicToolUseBlock>
  model: string
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null
  stop_sequence: string | null
  usage: AnthropicUsage
}

export type AnthropicRawMessageStartEvent = {
  type: 'message_start'
  message: AnthropicMessageResponse
}

export type AnthropicRawContentBlockStartEvent = {
  type: 'content_block_start'
  index: number
  content_block: AnthropicTextBlock | AnthropicToolUseBlock
}

export type AnthropicRawContentBlockDeltaEvent = {
  type: 'content_block_delta'
  index: number
  delta:
    | {
        type: 'text_delta'
        text: string
      }
    | {
        type: 'input_json_delta'
        partial_json: string
      }
}

export type AnthropicRawContentBlockStopEvent = {
  type: 'content_block_stop'
  index: number
}

export type AnthropicRawMessageDeltaEvent = {
  type: 'message_delta'
  delta: {
    stop_reason: AnthropicMessageResponse['stop_reason']
    stop_sequence: string | null
  }
  usage: {
    output_tokens: number
  }
}

export type AnthropicRawMessageStopEvent = {
  type: 'message_stop'
}

export type UpstreamMessageContentItem =
  | {
      type: 'output_text'
      text: string
    }
  | {
      type: 'input_text'
      text: string
    }
  | {
      type: 'input_image'
      image_url: string
    }
  | {
      type: string
      [key: string]: unknown
    }

export type UpstreamFunctionTool = {
  type: 'function'
  name: string
  description?: string
  parameters?: Record<string, unknown>
  strict?: boolean
}

export type UpstreamInputMessageItem = {
  role: 'user' | 'assistant' | 'system' | 'developer'
  content: string | UpstreamMessageContentItem[]
}

export type UpstreamFunctionCallItem = {
  type: 'function_call'
  id?: string
  call_id: string
  name: string
  arguments: string
}

export type UpstreamFunctionCallOutputItem = {
  type: 'function_call_output'
  call_id: string
  output: string
}

export type UpstreamInputItem =
  | UpstreamInputMessageItem
  | UpstreamFunctionCallItem
  | UpstreamFunctionCallOutputItem

export type UpstreamResponseOutputItem =
  | {
      type: 'message'
      role?: 'assistant'
      content?: UpstreamMessageContentItem[]
    }
  | UpstreamFunctionCallItem
  | {
      type: 'reasoning'
      summary?: Array<{ text?: string }>
      [key: string]: unknown
    }
  | {
      type: string
      [key: string]: unknown
    }

export type UpstreamUsage = {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  input_tokens_details?: {
    cached_tokens?: number
  }
}

export type UpstreamResponse = {
  id: string
  status?: string
  model?: string
  output?: UpstreamResponseOutputItem[]
  output_text?: string
  usage?: UpstreamUsage
  incomplete_details?: {
    reason?: string
  }
}

export type UpstreamResponsesRequest = {
  model: string
  input: UpstreamInputItem[]
  instructions?: string
  tools?: UpstreamFunctionTool[]
  tool_choice?: string | Record<string, unknown>
  parallel_tool_calls?: boolean
  max_output_tokens?: number
  previous_response_id?: string
  stream?: boolean
  metadata?: Record<string, string>
}

export type ProxyConfig = {
  listenHost?: string
  listenPort?: number
  upstreamURL: string
  upstreamKey: string
  upstreamModel?: string
  upstreamHeaders?: Record<string, string>
  logger?: (line: string) => void
}

export type RunningOpenAIResponsesCompatProxy = {
  port: number
  host: string
  stop: () => void
}
