import { ProviderHttpError, ProviderNetworkError } from './errors'
import { parseJsonObject } from './json'
import { createManualPrompt } from './prompts'
import type {
  AiProvider,
  ManualTranslateInput,
  ManualTranslateOutput,
  ProviderConfig,
  ProviderSecret,
  ProviderTestOutput,
} from './types'

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
  }
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
    const response = await this.complete(createManualPrompt(input), {}, signal)
    const parsed = parseJsonObject<ManualTranslateOutput>(response.content)
    return { ...parsed, usage: response.usage }
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
    return { ok: true, text, usage: response.usage }
  }

  private async complete(
    prompt: string,
    options: { maxTokens?: number; system?: string } = {},
    signal?: AbortSignal,
  ): Promise<{ content: string; usage?: { inputTokens?: number; outputTokens?: number } }> {
    const apiKey = this.secret.apiKey

    if (!apiKey) {
      throw new Error(`Missing API key for provider: ${this.config.type}`)
    }

    const system =
      options.system ?? 'You are a subtitle translation engine. Return valid JSON only.'
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

    return {
      content,
      usage: {
        inputTokens: json.usageMetadata?.promptTokenCount,
        outputTokens: json.usageMetadata?.candidatesTokenCount,
      },
    }
  }
}
