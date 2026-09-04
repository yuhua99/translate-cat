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
import { getSseError, isSseRateLimited, readProviderSse } from './stream'
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

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string | Array<{ text?: string; type?: string }> } }>
  output_text?: string
}

interface CompletionOptions {
  maxTokens?: number
  json?: boolean
  system: string
}

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: { content?: unknown }
    finish_reason?: unknown
  }>
  error?: unknown
}

export class OpenAiProvider implements AiProvider {
  constructor(
    private readonly config: ProviderConfig,
    private readonly secret: ProviderSecret,
    private readonly defaultBaseUrl = 'https://api.openai.com/v1',
    private readonly providerLabel = 'OpenAI',
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
      json: false,
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
    if (!this.secret.apiKey) {
      throw new Error(`Missing API key for provider: ${this.config.type}`)
    }

    const response = await this.fetchChatCompletionResponse(
      createSelectionPrompt(input),
      { json: false, system: createSelectionSystemPrompt(input) },
      options.signal,
      true,
    )

    let hasText = false
    let completed = false

    await readProviderSse(response, this.providerLabel, options.signal, (message) => {
      const chunk = parseOpenAiStreamChunk(message.data, this.providerLabel)
      throwOpenAiStreamError(chunk.error, this.providerLabel)

      const choice = chunk.choices?.[0]
      if (!choice) return undefined

      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        if (choice.finish_reason !== 'stop') {
          const finishReason =
            typeof choice.finish_reason === 'string'
              ? choice.finish_reason
              : JSON.stringify(choice.finish_reason)
          throw new ProviderSseError(`${this.providerLabel} response finished with ${finishReason}`)
        }
        completed = true
      }

      const content = choice.delta?.content
      if (content === undefined || content === null) return undefined
      if (typeof content !== 'string') {
        throw new ProviderJsonParseError(`${this.providerLabel} SSE text delta is malformed`)
      }
      if (!content) return undefined

      hasText = true
      options.onDelta(content)
      return undefined
    })

    if (!hasText) {
      throw new ProviderJsonParseError(`${this.providerLabel} SSE response did not include text`)
    }
    if (!completed) {
      throw new ProviderJsonParseError(`${this.providerLabel} SSE stream ended before completion`)
    }
  }

  private async complete(
    prompt: string,
    options: CompletionOptions,
    signal?: AbortSignal,
  ): Promise<{ content: string }> {
    if (!this.secret.apiKey) {
      throw new Error(`Missing API key for provider: ${this.config.type}`)
    }

    if (options.json !== false) {
      try {
        return await this.fetchAndParse(prompt, options, signal)
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof ProviderJsonParseError) {
          // Fall through to retry without json_object
        } else {
          throw error
        }
      }
    }

    return await this.fetchAndParse(prompt, { ...options, json: false }, signal)
  }

  private async fetchAndParse(
    prompt: string,
    options: CompletionOptions,
    signal?: AbortSignal,
  ): Promise<{ content: string }> {
    const responseText = await this.fetchChatCompletion(prompt, options, signal)
    const json = JSON.parse(responseText) as OpenAiResponse
    const content = extractOpenAiContent(json)

    if (!content) {
      throw new Error(`OpenAI response missing message content: ${responseText.slice(0, 500)}`)
    }

    return { content: content ?? '' }
  }

  protected extraChatCompletionBody(): Record<string, unknown> {
    return this.shouldDisableThinking() ? { reasoning_effort: 'none' } : {}
  }

  protected shouldDisableThinking(): boolean {
    return shouldDisableThinking(this.config)
  }

  protected extraChatCompletionHeaders(): Record<string, string> {
    return {}
  }

  private async fetchChatCompletion(
    prompt: string,
    options: CompletionOptions,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.fetchChatCompletionResponse(prompt, options, signal)
    return await response.text()
  }

  private async fetchChatCompletionResponse(
    prompt: string,
    options: CompletionOptions,
    signal?: AbortSignal,
    stream = false,
  ): Promise<Response> {
    let response: Response
    try {
      response = await fetch(`${this.defaultBaseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${this.secret.apiKey}`,
          'content-type': 'application/json',
          ...this.extraChatCompletionHeaders(),
        },
        body: JSON.stringify({
          model: this.config.model,
          ...(options.maxTokens ? { max_completion_tokens: options.maxTokens } : {}),
          ...(stream ? { stream: true } : {}),
          ...(stream || options.json === false ? {} : { response_format: { type: 'json_object' } }),
          ...this.extraChatCompletionBody(),
          messages: [
            {
              role: 'system',
              content: options.system,
            },
            { role: 'user', content: prompt },
          ],
        }),
      })
    } catch (error) {
      throw new ProviderNetworkError(error instanceof Error ? error.message : String(error), {
        cause: error,
      })
    }

    if (!response.ok) {
      throw new ProviderHttpError(
        `${this.providerLabel} request failed: ${response.status} ${await response.text()}`,
        response.status,
      )
    }

    return response
  }
}

function parseOpenAiStreamChunk(data: string, providerLabel: string): OpenAiStreamChunk {
  let chunk: unknown
  try {
    chunk = JSON.parse(data)
  } catch (error) {
    throw new ProviderJsonParseError(
      `${providerLabel} SSE event is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!chunk || typeof chunk !== 'object') {
    throw new ProviderJsonParseError(`${providerLabel} SSE event is malformed`)
  }

  return chunk as OpenAiStreamChunk
}

function throwOpenAiStreamError(error: unknown, providerLabel: string): void {
  if (error === undefined || error === null) return

  const errorDetails = getSseError(error)
  const formatted =
    errorDetails.code && errorDetails.code !== errorDetails.message
      ? `${errorDetails.code}: ${errorDetails.message}`
      : errorDetails.message

  if (isSseRateLimited(errorDetails)) {
    throw new ProviderHttpError(`${providerLabel} response failed: ${formatted}`, 429)
  }
  throw new ProviderSseError(`${providerLabel} response failed: ${formatted}`)
}

function extractOpenAiContent(json: OpenAiResponse): string | undefined {
  if (json.output_text) {
    return json.output_text
  }

  const content = json.choices?.[0]?.message?.content

  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content.map((part) => part.text ?? '').join('')
  }

  return undefined
}
