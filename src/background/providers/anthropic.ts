import { shouldDisableThinking } from '../../shared/providers'
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
import { getSseError, readProviderSse } from './stream'
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

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>
  stop_reason?: string
}

interface AnthropicSseEvent {
  type?: unknown
  delta?: unknown
  error?: unknown
}

interface AnthropicSseDelta {
  type: string
  text?: unknown
}

export class AnthropicProvider implements AiProvider {
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
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: options.signal,
        headers: {
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 8192,
          temperature: 0,
          stream: true,
          ...(shouldDisableThinking(this.config) ? { thinking: { type: 'disabled' } } : {}),
          system: createSelectionSystemPrompt(input),
          messages: [{ role: 'user', content: createSelectionPrompt(input) }],
        }),
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new ProviderNetworkError(error instanceof Error ? error.message : String(error), {
        cause: error,
      })
    }

    if (!response.ok) {
      throw new ProviderHttpError(
        `Anthropic request failed: ${response.status} ${await response.text()}`,
        response.status,
      )
    }

    await streamSelection(response, options)
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

  private async complete(
    prompt: string,
    options: { maxTokens?: number; system: string },
    signal?: AbortSignal,
  ): Promise<{ content: string }> {
    const apiKey = this.secret.apiKey

    if (!apiKey) {
      throw new Error(`Missing API key for provider: ${this.config.type}`)
    }

    let response: Response
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal,
        headers: {
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: options.maxTokens ?? 8192,
          temperature: 0,
          ...(shouldDisableThinking(this.config) ? { thinking: { type: 'disabled' } } : {}),
          system: options.system,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
    } catch (error) {
      throw new ProviderNetworkError(error instanceof Error ? error.message : String(error), {
        cause: error,
      })
    }

    if (!response.ok) {
      throw new ProviderHttpError(
        `Anthropic request failed: ${response.status} ${await response.text()}`,
        response.status,
      )
    }

    const json = (await response.json()) as AnthropicResponse

    if (json.stop_reason === 'max_tokens') {
      // Plain Error on purpose: isRetryableError must not retry — the same
      // truncation would recur. Do not convert to ProviderJsonParseError.
      throw new Error('Anthropic response truncated at max_tokens limit')
    }

    const content = json.content?.find((item) => item.type === 'text')?.text

    if (!content) {
      throw new Error('Anthropic response missing text content')
    }

    return { content }
  }
}

async function streamSelection(response: Response, options: SelectionStreamOptions): Promise<void> {
  const stopped = await readProviderSse(response, 'Anthropic', options.signal, (message) => {
    const event = parseSseEvent(message.data)

    if (message.event === 'error' || event.type === 'error') {
      throw createSseError(event.error)
    }

    if (
      event.type === 'message_delta' &&
      event.delta &&
      typeof event.delta === 'object' &&
      (event.delta as { stop_reason?: unknown }).stop_reason === 'max_tokens'
    ) {
      throw new ProviderSseError('Anthropic response truncated at max_tokens limit')
    }

    if (event.type === 'content_block_delta') {
      const delta = event.delta
      if (!isSseDelta(delta)) {
        throw new ProviderJsonParseError('Anthropic SSE text delta is malformed')
      }
      if (delta.type === 'text_delta') {
        if (typeof delta.text !== 'string') {
          throw new ProviderJsonParseError('Anthropic SSE text delta is malformed')
        }
        options.onDelta(delta.text)
      }
    }

    if (message.event === 'message_stop' || event.type === 'message_stop') return true
    return undefined
  })

  if (stopped) return

  throw new ProviderJsonParseError('Anthropic SSE stream ended before message_stop')
}

function parseSseEvent(data: string): AnthropicSseEvent {
  let event: unknown
  try {
    event = JSON.parse(data)
  } catch (error) {
    throw new ProviderJsonParseError(
      `Anthropic SSE event is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (
    !event ||
    typeof event !== 'object' ||
    typeof (event as AnthropicSseEvent).type !== 'string'
  ) {
    throw new ProviderJsonParseError('Anthropic SSE event is malformed')
  }

  return event as AnthropicSseEvent
}

function isSseDelta(value: unknown): value is AnthropicSseDelta {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as AnthropicSseDelta).type === 'string'
  )
}

function createSseError(error: unknown): Error {
  const { code: type, message } = getSseError(error, ['type'])
  const formatted = type && type !== message ? `${type}: ${message}` : message
  const providerMessage = `Anthropic response failed: ${formatted}`

  if (type === 'rate_limit_error') return new ProviderHttpError(providerMessage, 429)
  if (type === 'overloaded_error') return new ProviderHttpError(providerMessage, 529)
  if (type === 'api_error') return new ProviderHttpError(providerMessage, 500)
  return new ProviderSseError(providerMessage)
}
