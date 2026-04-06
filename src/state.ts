import { createHash } from 'crypto'
import type { AnthropicContentBlock, AnthropicMessageParam } from './types.js'

export function computeAssistantSignature(
  message: AnthropicMessageParam | AnthropicContentBlock[],
): string {
  const content = Array.isArray(message) ? message : message.content
  const normalized = typeof content === 'string' ? content : JSON.stringify(content)
  return createHash('sha256').update(normalized).digest('hex')
}

export class ProxyStateStore {
  #assistantToResponseId = new Map<string, string>()

  rememberAssistantResponse(
    assistantContent: AnthropicContentBlock[],
    upstreamResponseId: string,
  ): void {
    this.#assistantToResponseId.set(
      computeAssistantSignature(assistantContent),
      upstreamResponseId,
    )
  }

  findPreviousResponseId(messages: AnthropicMessageParam[]): {
    assistantIndex: number
    responseId: string
  } | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== 'assistant') {
        continue
      }

      const responseId = this.#assistantToResponseId.get(
        computeAssistantSignature(message),
      )
      if (responseId) {
        return { assistantIndex: index, responseId }
      }
    }

    return null
  }
}
