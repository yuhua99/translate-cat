import {
  ProviderHttpError,
  ProviderJsonParseError,
  ProviderNetworkError,
  ProviderSseError,
} from './errors'
import { parseJsonObject } from './json'
import {
  createManualPrompt,
  createManualSystemPrompt,
  createSelectionPrompt,
  createSelectionSystemPrompt,
} from './prompts'
import { readProviderSse } from './stream'
import type {
  AiProvider,
  ManualTranslateInput,
  ManualTranslateOutput,
  ProviderConfig,
  ProviderSecret,
  ProviderTestOutput,
  SelectionStreamOptions,
  SelectionTranslateInput,
} from './types'

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> }
    finishReason?: string
  }>
  error?: unknown
  promptFeedback?: unknown
}

export class GeminiProvider implements AiProvider {
  constructor(
    private readonly config: ProviderConfig,
    private readonly secret: ProviderSecret,
  ) {}

  async translateManual(
    input: ManualTranslateInput,
    signal?: AbortSignal,
  ): Promise<ManualTranslateOutput> {
    const response = await this.complete(
      createManualPrompt(input),
      { system: createManualSystemPrompt() },
      signal,
    )
    return parseJsonObject<ManualTranslateOutput>(response.content)
  }

  async testConnection(): Promise<ProviderTestOutput> {
    const response = await this.complete('Reply exactly: OK', {
      maxTokens: 40,
      system: 'Reply exactly: OK',
    })
    const text = response.content.trim()
    if (text !== 'OK') {
      throw new Error(`Provider test failed: expected OK, got ${text}`)
    }
    return { ok: true }
  }

  async translateSelection(
    input: SelectionTranslateInput,
    options: SelectionStreamOptions,
  ): Promise<void> {
    const apiKey = this.secret.apiKey

    if (!apiKey) {
      throw new Error(`Missing API key for provider: ${this.config.type}`)
    }

    let response: Response
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          signal: options.signal,
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: createSelectionSystemPrompt(input) }] },
            contents: [{ role: 'user', parts: [{ text: createSelectionPrompt(input) }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 8192 },
          }),
        },
      )
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new ProviderNetworkError(error instanceof Error ? error.message : String(error), {
        cause: error,
      })
    }

    if (!response.ok) {
      throw new ProviderHttpError(
        `Gemini request failed: ${response.status} ${await response.text()}`,
        response.status,
      )
    }

    let hasText = false
    let finished = false

    await readProviderSse(response, 'Gemini', options.signal, (message) => {
      let event: GeminiResponse
      try {
        event = JSON.parse(message.data) as GeminiResponse
      } catch (error) {
        throw new ProviderJsonParseError(
          `Gemini SSE event is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new ProviderJsonParseError('Gemini SSE event is malformed')
      }

      if (event.error !== undefined) throw geminiStreamError(event.error)
      if (
        event.promptFeedback &&
        typeof event.promptFeedback === 'object' &&
        'blockReason' in event.promptFeedback
      ) {
        throw new ProviderSseError(
          `Gemini prompt blocked: ${formatGeminiValue(event.promptFeedback)}`,
        )
      }

      if (event.candidates !== undefined && !Array.isArray(event.candidates)) {
        throw new ProviderJsonParseError('Gemini SSE candidates are malformed')
      }

      for (const candidate of event.candidates ?? []) {
        if (!candidate || typeof candidate !== 'object') {
          throw new ProviderJsonParseError('Gemini SSE candidate is malformed')
        }

        const parts = candidate.content?.parts
        if (parts !== undefined && !Array.isArray(parts)) {
          throw new ProviderJsonParseError('Gemini SSE content parts are malformed')
        }

        for (const part of parts ?? []) {
          if (!part || typeof part !== 'object') {
            throw new ProviderJsonParseError('Gemini SSE content part is malformed')
          }
          if (!part.thought && typeof part.text === 'string' && part.text) {
            hasText = true
            options.onDelta(part.text)
          }
        }

        if (candidate.finishReason) {
          if (candidate.finishReason === 'MAX_TOKENS') {
            throw new ProviderSseError('Gemini response truncated at MAX_TOKENS limit')
          }
          if (candidate.finishReason !== 'STOP') {
            throw new ProviderSseError(`Gemini response finished with ${candidate.finishReason}`)
          }
          finished = true
        }
      }

      return undefined
    })

    if (!finished) {
      throw new ProviderJsonParseError('Gemini SSE stream ended before a finish reason')
    }
    if (!hasText) {
      throw new ProviderJsonParseError('Gemini SSE stream did not include text content')
    }
  }

  private async complete(
    prompt: string,
    options: { maxTokens?: number; system: string },
    signal?: AbortSignal,
  ): Promise<{ content: string }> {
    const apiKey = this.secret.apiKey

    if (!apiKey) {
      throw new Error(`Missing API key for provider: ${this.config.type}`)
    }

    const system = options.system
    const maxOutputTokens = options.maxTokens ?? 8192

    let response: Response
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent`,
        {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, maxOutputTokens },
          }),
        },
      )
    } catch (error) {
      throw new ProviderNetworkError(error instanceof Error ? error.message : String(error), {
        cause: error,
      })
    }

    if (!response.ok) {
      throw new ProviderHttpError(
        `Gemini request failed: ${response.status} ${await response.text()}`,
        response.status,
      )
    }

    const json = (await response.json()) as GeminiResponse
    const candidate = json.candidates?.[0]

    if (candidate?.finishReason === 'MAX_TOKENS') {
      // Plain Error on purpose: isRetryableError must not retry — the same
      // truncation would recur. Do not convert to ProviderJsonParseError.
      throw new Error('Gemini response truncated at MAX_TOKENS limit')
    }

    const content = candidate?.content?.parts?.map((part) => part.text ?? '').join('')

    if (!content) {
      throw new Error('Gemini response missing text content')
    }

    return { content }
  }
}

function geminiStreamError(error: unknown): Error {
  const value =
    error && typeof error === 'object' ? (error as { code?: unknown; message?: unknown }) : {}
  const message = typeof value.message === 'string' ? value.message : formatGeminiValue(error)

  if (typeof value.code === 'number') {
    return new ProviderHttpError(`Gemini response failed: ${message}`, value.code)
  }

  return new ProviderSseError(`Gemini response failed: ${message}`)
}

function formatGeminiValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
