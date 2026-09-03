import { afterEach, describe, expect, test } from 'bun:test'
import {
  translateSelectionMessage,
  type SelectionTranslationErrorMessages,
} from '../../src/background/providers/subtitle-translation'
import type { ProviderStorageArea, ProviderStores } from '../../src/background/providers/storage'
import { sseEvents } from '../helpers/sse'

const originalFetch = globalThis.fetch
const errors = {
  missingApiKey: (providerType) => `Missing API key for ${providerType}`,
  notSignedInCodex: () => 'Not signed in to OpenAI Codex',
  noTranslation: () => 'No translation returned',
} satisfies SelectionTranslationErrorMessages

function createMemoryStorage(initial: Record<string, unknown> = {}): ProviderStorageArea {
  const data = { ...initial }
  return {
    async get(key: string | string[]): Promise<Record<string, unknown>> {
      if (Array.isArray(key)) {
        return Object.fromEntries(key.map((item) => [item, data[item]]))
      }
      return { [key]: data[key] }
    },
    async set(items: Record<string, unknown>): Promise<void> {
      Object.assign(data, items)
    },
  }
}

function createStores(apiKey = 'test-key'): ProviderStores {
  return {
    sync: createMemoryStorage({
      subtitleEnabled: false,
      selectionEnabled: true,
      targetLanguage: 'zh-TW',
      provider: { type: 'openai', model: 'gpt-4.1-mini' },
    }),
    local: createMemoryStorage({ providerSecrets: { openai: { apiKey } } }),
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('selection translation stream', () => {
  test('retries streamed output with a reset before replacement deltas', async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      if (calls === 1) {
        return sseEvents([{ choices: [{ delta: { content: 'partial' } }] }])
      }
      return sseEvents([
        { choices: [{ delta: { content: '完成' } }] },
        { choices: [{ finish_reason: 'stop' }] },
      ])
    }
    const events: string[] = []

    await expect(
      translateSelectionMessage(
        { type: 'translate', requestId: 'request-1', text: 'Hello', targetLanguage: 'zh-TW' },
        createStores(),
        {
          onDelta: (text) => events.push(`delta:${text}`),
          onReset: () => events.push('reset'),
          errors,
        },
      ),
    ).resolves.toEqual({ ok: true })

    expect(calls).toBe(2)
    expect(events).toEqual(['delta:partial', 'reset', 'delta:完成'])
  })

  test('returns a localized error for whitespace-only translations', async () => {
    globalThis.fetch = async () =>
      sseEvents([
        { choices: [{ delta: { content: '   ' } }] },
        { choices: [{ finish_reason: 'stop' }] },
      ])
    const events: string[] = []

    await expect(
      translateSelectionMessage(
        { type: 'translate', requestId: 'request-1', text: 'Hello', targetLanguage: 'zh-TW' },
        createStores(),
        {
          onDelta: (text) => events.push(`delta:${text}`),
          onReset: () => events.push('reset'),
          errors,
        },
      ),
    ).resolves.toEqual({ ok: false, error: 'No translation returned', fatal: false })

    expect(events).toEqual(['delta:   '])
  })

  test('uses the existing missing API key message without starting a request', async () => {
    let fetchCalls = 0
    globalThis.fetch = async () => {
      fetchCalls += 1
      return new Response()
    }

    const result = await translateSelectionMessage(
      { type: 'translate', requestId: 'request-1', text: 'Hello', targetLanguage: 'zh-TW' },
      createStores(''),
      {
        onDelta: () => undefined,
        onReset: () => undefined,
        errors,
      },
    )

    expect(result).toEqual({ ok: false, error: 'Missing API key for openai', fatal: false })
    expect(fetchCalls).toBe(0)
  })

  test('stops before fetching when the signal is aborted', async () => {
    let fetchCalls = 0
    globalThis.fetch = async () => {
      fetchCalls += 1
      return new Response()
    }
    const controller = new AbortController()
    controller.abort()

    const result = await translateSelectionMessage(
      { type: 'translate', requestId: 'request-1', text: 'Hello', targetLanguage: 'zh-TW' },
      createStores(),
      { signal: controller.signal, onDelta: () => undefined, onReset: () => undefined, errors },
    )

    expect(result).toEqual({ ok: false, error: 'aborted', fatal: false })
    expect(fetchCalls).toBe(0)
  })
})
