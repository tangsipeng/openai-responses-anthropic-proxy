import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { createHash } from 'crypto'
import type { AnthropicContentBlock, AnthropicMessageParam } from './types.js'

type PersistedProxyState = {
  assistantToResponseId: Record<string, string>
}

function normalizeAssistantContent(
  message: AnthropicMessageParam,
): AnthropicContentBlock[] {
  return typeof message.content === 'string'
    ? [{ type: 'text', text: message.content, citations: null }]
    : message.content
}

export function computeAssistantSignature(
  message: AnthropicMessageParam | AnthropicContentBlock[],
): string {
  const content = Array.isArray(message) ? message : message.content
  const normalized = typeof content === 'string' ? content : JSON.stringify(content)
  return createHash('sha256').update(normalized).digest('hex')
}

export class ProxyStateStore {
  #assistantToResponseId = new Map<string, string>()
  #stateFilePath?: string

  constructor(stateFilePath?: string) {
    this.#stateFilePath = stateFilePath
    this.#loadFromDisk()
  }

  #loadFromDisk(): void {
    if (!this.#stateFilePath) {
      return
    }

    try {
      const raw = readFileSync(this.#stateFilePath, 'utf8')
      if (!raw.trim()) {
        return
      }

      const parsed = JSON.parse(raw) as Partial<PersistedProxyState>
      const entries = parsed.assistantToResponseId
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        return
      }

      for (const [signature, responseId] of Object.entries(entries)) {
        if (typeof responseId !== 'string' || !responseId) {
          continue
        }
        this.#assistantToResponseId.set(signature, responseId)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw error
    }
  }

  #persistToDisk(): void {
    if (!this.#stateFilePath) {
      return
    }

    mkdirSync(dirname(this.#stateFilePath), { recursive: true })

    const tempFilePath = `${this.#stateFilePath}.${process.pid}.${Date.now()}.tmp`
    const payload: PersistedProxyState = {
      assistantToResponseId: Object.fromEntries(this.#assistantToResponseId),
    }

    writeFileSync(tempFilePath, JSON.stringify(payload), 'utf8')
    renameSync(tempFilePath, this.#stateFilePath)
  }

  #rememberSignature(signature: string, upstreamResponseId: string): void {
    this.#assistantToResponseId.set(signature, upstreamResponseId)
  }

  rememberAssistantResponse(
    assistantContent: AnthropicContentBlock[],
    upstreamResponseId: string,
  ): void {
    this.#rememberSignature(
      computeAssistantSignature(assistantContent),
      upstreamResponseId,
    )

    for (const block of assistantContent) {
      if (block.type !== 'tool_use') {
        continue
      }
      this.#rememberSignature(
        computeAssistantSignature([block]),
        upstreamResponseId,
      )
    }

    this.#persistToDisk()
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

      let combinedContent = normalizeAssistantContent(message)
      for (
        let endIndex = index + 1;
        endIndex < messages.length && messages[endIndex]?.role === 'assistant';
        endIndex += 1
      ) {
        combinedContent = combinedContent.concat(
          normalizeAssistantContent(messages[endIndex]!),
        )

        const combinedResponseId = this.#assistantToResponseId.get(
          computeAssistantSignature(combinedContent),
        )
        if (combinedResponseId) {
          return { assistantIndex: endIndex, responseId: combinedResponseId }
        }
      }
    }

    return null
  }
}
