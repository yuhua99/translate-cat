import { afterEach, describe, expect, test } from 'bun:test'
import { AnthropicProvider } from '../../src/background/providers/anthropic'
import {
  ProviderHttpError,
  ProviderJsonParseError,
  ProviderNetworkError,
} from '../../src/background/providers/errors'
import { GeminiProvider } from '../../src/background/providers/gemini'
import { parseJsonObject } from '../../src/background/providers/json'
import { OpenAiProvider } from '../../src/background/providers/openai'
import {
  OPENCODE_ZEN_BASE_URL,
  OpencodeZenProvider,
} from '../../src/background/providers/opencode-zen'
import {
  getProviderConfig,
  getProviderSecret,
  setProviderConfig,
  setProviderSecret,
  type ProviderStorageArea,
} from '../../src/background/providers/storage'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function createMemoryStorage(
  initial: Record<string, unknown> = {},
): ProviderStorageArea & { data: Record<string, unknown> } {
  const data = { ...initial }

  return {
    data,
    async get(key: string): Promise<Record<string, unknown>> {
      return { [key]: data[key] }
    },
    async set(items: Record<string, unknown>): Promise<void> {
      Object.assign(data, items)
    },
  }
}

describe('parseJsonObject', () => {
  test('parses raw, fenced, and embedded JSON', () => {
    expect(parseJsonObject<{ ok: true }>('{"ok":true}')).toEqual({ ok: true })
    expect(parseJsonObject<{ ok: true }>('```json\n{"ok":true}\n```')).toEqual({ ok: true })
    expect(parseJsonObject<{ ok: true }>('text {"ok":true} text')).toEqual({ ok: true })
  })
})

describe('provider storage', () => {
  test('stores config in sync storage and secret separately by provider type', async () => {
    const sync = createMemoryStorage()
    const local = createMemoryStorage()

    await setProviderConfig(sync, { type: 'openai', model: 'gpt-4.1-mini' })
    await setProviderSecret(local, 'openai', { apiKey: 'secret-key' })

    await expect(getProviderConfig(sync, 'openai')).resolves.toEqual({
      type: 'openai',
      model: 'gpt-4.1-mini',
    })
    await expect(getProviderSecret(local, 'openai')).resolves.toEqual({ apiKey: 'secret-key' })
    expect(JSON.stringify(sync.data)).not.toContain('secret-key')
  })
})

describe('OpenAiProvider', () => {
  test('tests connection with tiny request', async () => {
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({
        choices: [{ message: { content: 'OK' } }],
        usage: { prompt_tokens: 4, completion_tokens: 1 },
      })
    }

    const provider = new OpenAiProvider(
      { type: 'openai', model: 'gpt-4.1-mini' },
      { apiKey: 'key' },
    )

    await expect(provider.testConnection()).resolves.toEqual({
      ok: true,
      text: 'OK',
      usage: { inputTokens: 4, outputTokens: 1 },
    })
    expect(requestBody?.max_completion_tokens).toBe(40)
    expect(requestBody).not.toHaveProperty('response_format')
  })

  test('sends chat completion request and parses manual translations', async () => {
    let request: Request | undefined
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init)
      return Response.json({
        choices: [{ message: { content: '{"translations":[{"id":"a","text":"你好"}]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
    }

    const provider = new OpenAiProvider(
      { type: 'openai', model: 'gpt-4.1-mini' },
      { apiKey: 'key' },
    )
    const result = await provider.translateManual({
      targetLanguage: 'Traditional Chinese',
      items: [{ id: 'a', text: 'Hello', startMs: 0 }],
    })

    expect(request?.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(request?.headers.get('authorization')).toBe('Bearer key')
    expect(result).toEqual({
      translations: [{ id: 'a', text: '你好' }],
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  })

  test('forwards abort signal to fetch', async () => {
    let receivedSignal: AbortSignal | null | undefined
    globalThis.fetch = async (_input, init) => {
      receivedSignal = init?.signal
      return Response.json({
        choices: [{ message: { content: '{"translations":[{"id":"a","text":"你好"}]}' } }],
      })
    }

    const controller = new AbortController()
    const provider = new OpenAiProvider(
      { type: 'openai', model: 'gpt-4.1-mini' },
      { apiKey: 'key' },
    )
    await provider.translateManual(
      { targetLanguage: 'zh-TW', items: [{ id: 'a', text: 'Hello', startMs: 0 }] },
      controller.signal,
    )

    expect(receivedSignal).toBe(controller.signal)
  })
})

describe('OpencodeZenProvider', () => {
  test('uses opencode Zen Go base URL', async () => {
    let request: Request | undefined
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init)
      return Response.json({
        choices: [{ message: { content: '{"translations":[{"id":"a","text":"你好"}]}' } }],
      })
    }

    const provider = new OpencodeZenProvider(
      { type: 'opencodeZen', model: 'qwen3.6-plus' },
      { apiKey: 'key' },
    )
    await provider.translateManual({
      targetLanguage: 'zh-TW',
      items: [{ id: 'a', text: 'Hello', startMs: 0 }],
    })

    expect(request?.url).toBe(`${OPENCODE_ZEN_BASE_URL}/chat/completions`)
    expect(await request?.json()).toMatchObject({ thinking: { type: 'disabled' } })
  })

  test('reports opencode Zen in request errors', async () => {
    globalThis.fetch = async () =>
      Response.json({ error: { message: 'bad request' } }, { status: 400 })

    const provider = new OpencodeZenProvider(
      { type: 'opencodeZen', model: 'deepseek-v3.2' },
      { apiKey: 'key' },
    )

    await expect(
      provider.translateManual({
        targetLanguage: 'zh-TW',
        items: [{ id: 'a', text: 'Hello', startMs: 0 }],
      }),
    ).rejects.toThrow('opencode Zen request failed: 400')
  })

  test('forwards abort signal to fetch', async () => {
    let receivedSignal: AbortSignal | null | undefined
    globalThis.fetch = async (_input, init) => {
      receivedSignal = init?.signal
      return Response.json({
        choices: [{ message: { content: '{"translations":[{"id":"a","text":"你好"}]}' } }],
      })
    }

    const controller = new AbortController()
    const provider = new OpencodeZenProvider(
      { type: 'opencodeZen', model: 'qwen3.6-plus' },
      { apiKey: 'key' },
    )
    await provider.translateManual(
      { targetLanguage: 'zh-TW', items: [{ id: 'a', text: 'Hello', startMs: 0 }] },
      controller.signal,
    )

    expect(receivedSignal).toBe(controller.signal)
  })
})

describe('GeminiProvider', () => {
  test('tests connection with tiny request', async () => {
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'OK' }] } }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 },
      })
    }

    const provider = new GeminiProvider(
      { type: 'gemini', model: 'gemini-2.5-flash' },
      { apiKey: 'key' },
    )

    await expect(provider.testConnection()).resolves.toEqual({
      ok: true,
      text: 'OK',
      usage: { inputTokens: 4, outputTokens: 1 },
    })
    expect(
      (requestBody?.generationConfig as { maxOutputTokens?: number } | undefined)?.maxOutputTokens,
    ).toBe(40)
  })

  test('testConnection throws on mismatched reply', async () => {
    globalThis.fetch = async () =>
      Response.json({
        candidates: [{ content: { parts: [{ text: 'nope' }] } }],
      })

    const provider = new GeminiProvider(
      { type: 'gemini', model: 'gemini-2.5-flash' },
      { apiKey: 'key' },
    )

    await expect(provider.testConnection()).rejects.toThrow(
      'Provider test failed: expected OK, got nope',
    )
  })

  test('sends generateContent request and parses manual translations', async () => {
    let request: Request | undefined
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init)
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({
        candidates: [
          { content: { parts: [{ text: '{"translations":[{"id":"a","text":"你好"}]}' }] } },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      })
    }

    const provider = new GeminiProvider(
      { type: 'gemini', model: 'gemini-2.5-flash' },
      { apiKey: 'key' },
    )
    const result = await provider.translateManual({
      targetLanguage: 'Traditional Chinese',
      items: [{ id: 'a', text: 'Hello', startMs: 0 }],
    })

    expect(request?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    )
    expect(request?.headers.get('x-goog-api-key')).toBe('key')
    expect(requestBody).toHaveProperty('contents')
    expect(requestBody).toHaveProperty('generationConfig')
    expect(result).toEqual({
      translations: [{ id: 'a', text: '你好' }],
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  })

  test('throws ProviderHttpError on non-2xx response', async () => {
    globalThis.fetch = async () => new Response('rate limited', { status: 429 })

    const provider = new GeminiProvider(
      { type: 'gemini', model: 'gemini-2.5-flash' },
      { apiKey: 'key' },
    )

    const promise = provider.translateManual({
      targetLanguage: 'zh-TW',
      items: [{ id: 'a', text: 'Hello', startMs: 0 }],
    })
    await expect(promise).rejects.toBeInstanceOf(ProviderHttpError)
    await expect(promise).rejects.toMatchObject({ status: 429 })
  })

  test('throws ProviderNetworkError on fetch rejection', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('network down')
    }

    const provider = new GeminiProvider(
      { type: 'gemini', model: 'gemini-2.5-flash' },
      { apiKey: 'key' },
    )

    await expect(
      provider.translateManual({
        targetLanguage: 'zh-TW',
        items: [{ id: 'a', text: 'Hello', startMs: 0 }],
      }),
    ).rejects.toBeInstanceOf(ProviderNetworkError)
  })

  test('fails clearly on MAX_TOKENS truncation with plain Error', async () => {
    globalThis.fetch = async () =>
      Response.json({
        candidates: [
          {
            content: { parts: [{ text: '{"translations":[{"id":"a","te' }] },
            finishReason: 'MAX_TOKENS',
          },
        ],
      })

    const provider = new GeminiProvider(
      { type: 'gemini', model: 'gemini-2.5-flash' },
      { apiKey: 'key' },
    )

    let caught: unknown
    try {
      await provider.translateManual({
        targetLanguage: 'zh-TW',
        items: [{ id: 'a', text: 'Hello', startMs: 0 }],
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(ProviderHttpError)
    expect(caught).not.toBeInstanceOf(ProviderNetworkError)
    expect(caught).not.toBeInstanceOf(ProviderJsonParseError)
    expect((caught as Error).message).toContain('MAX_TOKENS')
  })

  test('forwards abort signal to fetch', async () => {
    let receivedSignal: AbortSignal | null | undefined
    globalThis.fetch = async (_input, init) => {
      receivedSignal = init?.signal
      return Response.json({
        candidates: [
          { content: { parts: [{ text: '{"translations":[{"id":"a","text":"你好"}]}' }] } },
        ],
      })
    }

    const controller = new AbortController()
    const provider = new GeminiProvider(
      { type: 'gemini', model: 'gemini-2.5-flash' },
      { apiKey: 'key' },
    )
    await provider.translateManual(
      { targetLanguage: 'zh-TW', items: [{ id: 'a', text: 'Hello', startMs: 0 }] },
      controller.signal,
    )

    expect(receivedSignal).toBe(controller.signal)
  })
})

describe('AnthropicProvider', () => {
  test('tests connection with tiny request', async () => {
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 4, output_tokens: 1 },
      })
    }

    const provider = new AnthropicProvider(
      { type: 'anthropic', model: 'claude-sonnet-4-5' },
      { apiKey: 'key' },
    )

    await expect(provider.testConnection()).resolves.toEqual({
      ok: true,
      text: 'OK',
      usage: { inputTokens: 4, outputTokens: 1 },
    })
    expect(requestBody?.max_tokens).toBe(40)
  })

  test('translates with 8192 max_tokens and fails clearly on truncation', async () => {
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({
        content: [{ type: 'text', text: '{"translations":[{"id":"a","te' }],
        stop_reason: 'max_tokens',
      })
    }

    const provider = new AnthropicProvider(
      { type: 'anthropic', model: 'claude-sonnet-4-5' },
      { apiKey: 'key' },
    )

    await expect(
      provider.translateManual({
        targetLanguage: 'zh-TW',
        items: [{ id: 'a', text: 'Hello', startMs: 0 }],
      }),
    ).rejects.toThrow('Anthropic response truncated at max_tokens limit')
    expect(requestBody?.max_tokens).toBe(8192)
  })

  test('forwards abort signal to fetch', async () => {
    let receivedSignal: AbortSignal | null | undefined
    globalThis.fetch = async (_input, init) => {
      receivedSignal = init?.signal
      return Response.json({
        content: [{ type: 'text', text: '{"translations":[{"id":"a","text":"你好"}]}' }],
      })
    }

    const controller = new AbortController()
    const provider = new AnthropicProvider(
      { type: 'anthropic', model: 'claude-sonnet-4-5' },
      { apiKey: 'key' },
    )
    await provider.translateManual(
      { targetLanguage: 'zh-TW', items: [{ id: 'a', text: 'Hello', startMs: 0 }] },
      controller.signal,
    )

    expect(receivedSignal).toBe(controller.signal)
  })
})
