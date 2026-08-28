import { afterEach, describe, expect, test } from 'bun:test'
import {
  ProviderHttpError,
  ProviderJsonParseError,
  ProviderNetworkError,
} from '../../src/background/providers/errors'
import { GeminiProvider } from '../../src/background/providers/gemini'
import {
  createSelectionPrompt,
  createSelectionSystemPrompt,
} from '../../src/background/providers/prompts'
import { sseResponse } from '../helpers/sse'

const originalFetch = globalThis.fetch

function createProvider(): GeminiProvider {
  return new GeminiProvider({ type: 'gemini', model: 'gemini-2.5-flash' }, { apiKey: 'key' })
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('GeminiProvider selection streaming', () => {
  test('uses streamGenerateContent SSE and emits non-thinking text deltas', async () => {
    let request: Request | undefined
    let receivedSignal: AbortSignal | null | undefined
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init)
      receivedSignal = init?.signal
      return sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"thinking"},{"text":"你',
        '"}]}}]}\n\ndata: {"candidates":[{"content":{"parts":[{"text":"好"}]}}]}\n\n',
        'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
      ])
    }

    const input = { text: 'Hello', targetLanguage: 'Traditional Chinese' }
    const controller = new AbortController()
    const deltas: string[] = []
    await createProvider().translateSelection(input, {
      signal: controller.signal,
      onDelta: (delta) => deltas.push(delta),
    })

    expect(request?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    )
    expect(request?.headers.get('x-goog-api-key')).toBe('key')
    expect(receivedSignal).toBe(controller.signal)
    expect(await request?.json()).toEqual({
      systemInstruction: { parts: [{ text: createSelectionSystemPrompt(input) }] },
      contents: [{ role: 'user', parts: [{ text: createSelectionPrompt(input) }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 8192 },
    })
    expect(deltas).toEqual(['你', '好'])
  })

  test('classifies fetch and SSE errors with existing provider errors', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('network down')
    }
    await expect(
      createProvider().translateSelection(
        { text: 'Hello', targetLanguage: 'zh-TW' },
        { onDelta: () => undefined },
      ),
    ).rejects.toBeInstanceOf(ProviderNetworkError)

    globalThis.fetch = async () =>
      sseResponse(['data: {"error":{"code":429,"message":"rate limited"}}\n\n'])
    const error = createProvider().translateSelection(
      { text: 'Hello', targetLanguage: 'zh-TW' },
      { onDelta: () => undefined },
    )
    await expect(error).rejects.toBeInstanceOf(ProviderHttpError)
    await expect(error).rejects.toMatchObject({ status: 429 })
  })

  test('rejects malformed, incomplete, and empty SSE streams', async () => {
    const input = { text: 'Hello', targetLanguage: 'zh-TW' }
    const options = { onDelta: () => undefined }

    globalThis.fetch = async () => sseResponse(['data: not-json\n\n'])
    await expect(createProvider().translateSelection(input, options)).rejects.toBeInstanceOf(
      ProviderJsonParseError,
    )

    globalThis.fetch = async () =>
      sseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n'])
    await expect(createProvider().translateSelection(input, options)).rejects.toBeInstanceOf(
      ProviderJsonParseError,
    )

    globalThis.fetch = async () =>
      sseResponse(['data: {"candidates":[{"finishReason":"STOP"}]}\n\n'])
    await expect(createProvider().translateSelection(input, options)).rejects.toBeInstanceOf(
      ProviderJsonParseError,
    )
  })

  test('allows prompt feedback without a block reason', async () => {
    globalThis.fetch = async () =>
      sseResponse([
        'data: {"promptFeedback":{"safetyRatings":[{"category":"HARM_CATEGORY_HATE_SPEECH"}]}}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"你好"}]}}]}\n\n',
        'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
      ])

    const deltas: string[] = []
    await createProvider().translateSelection(
      { text: 'Hello', targetLanguage: 'zh-TW' },
      { onDelta: (delta) => deltas.push(delta) },
    )

    expect(deltas).toEqual(['你好'])
  })

  test('rejects prompt feedback with a block reason and non-STOP finish reasons without retryable errors', async () => {
    globalThis.fetch = async () =>
      sseResponse(['data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n'])
    await expect(
      createProvider().translateSelection(
        { text: 'Hello', targetLanguage: 'zh-TW' },
        { onDelta: () => undefined },
      ),
    ).rejects.toThrow('Gemini prompt blocked')

    globalThis.fetch = async () =>
      sseResponse(['data: {"candidates":[{"finishReason":"MAX_TOKENS"}]}\n\n'])
    await expect(
      createProvider().translateSelection(
        { text: 'Hello', targetLanguage: 'zh-TW' },
        { onDelta: () => undefined },
      ),
    ).rejects.toThrow('Gemini response truncated at MAX_TOKENS limit')
  })
})
