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

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string | Array<{ text?: string; type?: string }> } }>
  output_text?: string
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

interface CompletionOptions {
  maxTokens?: number
  json?: boolean
  system?: string
  allowEmptyContent?: boolean
}

export class OpenAiProvider implements AiProvider {
  constructor(
    private readonly config: ProviderConfig,
    private readonly secret: ProviderSecret,
    private readonly defaultBaseUrl = 'https://api.openai.com/v1',
    private readonly providerLabel = 'OpenAI',
  ) {}

  async translateManual(input: ManualTranslateInput): Promise<ManualTranslateOutput> {
    const response = await this.complete(createManualPrompt(input))
    const parsed = parseJsonObject<ManualTranslateOutput>(response.content)
    return { ...parsed, usage: response.usage }
  }

  async testConnection(): Promise<ProviderTestOutput> {
    const response = await this.complete('Reply exactly: OK', {
      maxTokens: 40,
      json: false,
      system: 'Reply exactly: OK',
      allowEmptyContent: false,
    })
    const text = response.content.trim()
    if (text !== 'OK') {
      throw new Error(`Provider test failed: expected OK, got ${text}`)
    }
    return { ok: true, text, usage: response.usage }
  }

  private async complete(
    prompt: string,
    options: CompletionOptions = {},
  ): Promise<{ content: string; usage?: { inputTokens?: number; outputTokens?: number } }> {
    if (!this.secret.apiKey) {
      throw new Error(`Missing API key for provider: ${this.config.type}`)
    }

    if (options.json !== false) {
      try {
        return await this.fetchAndParse(prompt, options)
      } catch (error) {
        if (
          error instanceof SyntaxError ||
          (error instanceof Error && /JSON|parse/i.test(error.message))
        ) {
          // Fall through to retry without json_object
        } else {
          throw error
        }
      }
    }

    return await this.fetchAndParse(prompt, { ...options, json: false })
  }

  private async fetchAndParse(
    prompt: string,
    options: CompletionOptions,
  ): Promise<{ content: string; usage?: { inputTokens?: number; outputTokens?: number } }> {
    const responseText = await this.fetchChatCompletion(prompt, options)
    const json = JSON.parse(responseText) as OpenAiResponse
    const content = extractOpenAiContent(json)

    if (!content && !options.allowEmptyContent) {
      throw new Error(`OpenAI response missing message content: ${responseText.slice(0, 500)}`)
    }

    return {
      content: content ?? '',
      usage: {
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
      },
    }
  }

  protected extraChatCompletionBody(): Record<string, unknown> {
    return {}
  }

  private async fetchChatCompletion(prompt: string, options: CompletionOptions): Promise<string> {
    const response = await fetch(`${this.defaultBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.secret.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0,
        ...(options.maxTokens ? { max_completion_tokens: options.maxTokens } : {}),
        ...(options.json === false ? {} : { response_format: { type: 'json_object' } }),
        ...this.extraChatCompletionBody(),
        messages: [
          {
            role: 'system',
            content:
              options.system ?? 'You are a subtitle translation engine. Return valid JSON only.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    })

    const responseText = await response.text()

    if (!response.ok) {
      throw new Error(`${this.providerLabel} request failed: ${response.status} ${responseText}`)
    }

    return responseText
  }
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
