import { afterEach, describe, expect, test } from 'bun:test'
import { translateTextMessage } from '../../src/background/providers/subtitle-translation'
import type { ProviderStores, ProviderStorageArea } from '../../src/background/providers/storage'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function createMemoryStorage(initial: Record<string, unknown> = {}): ProviderStorageArea {
  const data = { ...initial }

  return {
    async get(key: string): Promise<Record<string, unknown>> {
      return { [key]: data[key] }
    },
    async set(items: Record<string, unknown>): Promise<void> {
      Object.assign(data, items)
    },
  }
}

function createStores(): ProviderStores {
  return {
    sync: createMemoryStorage({ settings: { providerType: 'openai', targetLanguage: 'zh-TW' } }),
    local: createMemoryStorage({ providerSecrets: { openai: { apiKey: 'test-key' } } }),
  }
}

describe('translateTextMessage', () => {
  test('uses the selection prompt for a phrase', async () => {
    let requestBody: { messages?: Array<{ content?: string }> } | undefined
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> }
      return Response.json({
        choices: [
          {
            message: {
              content: '{"translations":[{"id":"sel-0","text":"你好世界"}]}',
            },
          },
        ],
      })
    }

    await expect(translateTextMessage('Hello world', createStores())).resolves.toEqual({
      ok: true,
      translation: '你好世界',
    })
    expect(requestBody?.messages?.[0]?.content).toBe(
      'You are a translation engine. Return valid JSON only.',
    )
    expect(requestBody?.messages?.[1]?.content).toContain('Translate the selected text to zh-TW.')
  })

  test('uses the dictionary prompt for a single word', async () => {
    let requestBody: { messages?: Array<{ content?: string }> } | undefined
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> }
      return Response.json({
        choices: [
          {
            message: {
              content: '{"translations":[{"id":"sel-0","text":"hello\\n名詞：問候語"}]}',
            },
          },
        ],
      })
    }

    await expect(translateTextMessage('  hello  ', createStores())).resolves.toEqual({
      ok: true,
      translation: 'hello\n名詞：問候語',
    })
    expect(requestBody?.messages?.[0]?.content).toBe(
      'You are a concise bilingual dictionary. Return valid JSON only.',
    )
    expect(requestBody?.messages?.[1]?.content).toContain(
      'Explain the word like a dictionary for a learner, in zh-TW.',
    )
  })

  test('401 response is fatal', async () => {
    let fetchCalls = 0
    globalThis.fetch = async () => {
      fetchCalls += 1
      return new Response('unauthorized', { status: 401 })
    }

    const result = await translateTextMessage('Hello world', createStores())

    expect(fetchCalls).toBe(1)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.fatal).toBe(true)
    }
  })

  test('400 response is non-retryable and non-fatal', async () => {
    let fetchCalls = 0
    globalThis.fetch = async () => {
      fetchCalls += 1
      return new Response('bad request', { status: 400 })
    }

    const result = await translateTextMessage('Hello world', createStores())

    expect(fetchCalls).toBe(1)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.fatal).toBe(false)
    }
  })

  test('returns empty translation when provider returns wrong id', async () => {
    globalThis.fetch = async () =>
      Response.json({
        choices: [
          {
            message: {
              content: '{"translations":[{"id":"other","text":"你好世界"}]}',
            },
          },
        ],
      })

    const result = await translateTextMessage('Hello world', createStores())

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('empty translation')
      expect(result.fatal).toBe(false)
    }
  })

  test('returns empty translation when provider returns null text', async () => {
    globalThis.fetch = async () =>
      Response.json({
        choices: [
          {
            message: {
              content: '{"translations":[{"id":"sel-0","text":null}]}',
            },
          },
        ],
      })

    const result = await translateTextMessage('Hello world', createStores())

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('empty translation')
      expect(result.fatal).toBe(false)
    }
  })
})
