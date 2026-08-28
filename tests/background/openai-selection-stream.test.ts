import { afterEach, describe, expect, test } from 'bun:test'
import {
  ProviderHttpError,
  ProviderJsonParseError,
  ProviderSseError,
} from '../../src/background/providers/errors'
import { OpenAiProvider } from '../../src/background/providers/openai'
import { OpencodeZenProvider } from '../../src/background/providers/opencode-zen'
import { sseResponse } from '../helpers/sse'

const originalFetch = globalThis.fetch

function createProvider(): OpenAiProvider {
  return new OpenAiProvider({ type: 'openai', model: 'gpt-5.6-luna' }, { apiKey: 'key' })
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('OpenAiProvider translateSelection', () => {
  test('sends a plain-text streamed request and emits content deltas across chunk boundaries', async () => {
    let request: Request | undefined
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init)
      return sseResponse([
        'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        'data: {"choices":[],"usage":{"total_tokens":3}}\n\n',
        'data: {"choices":[{"delta":{"content":"你',
        '好"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":"！"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ])
    }

    const deltas: string[] = []
    await createProvider().translateSelection(
      { text: 'Hello', targetLanguage: 'zh-TW' },
      { onDelta: (delta) => deltas.push(delta) },
    )

    const body = await request?.json()
    expect(request?.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(body).toMatchObject({
      model: 'gpt-5.6-luna',
      stream: true,
      reasoning_effort: 'none',
    })
    expect(body).not.toHaveProperty('response_format')
    expect(deltas).toEqual(['你好', '！'])
  })

  test('uses the OpenCode Zen override in streamed requests', async () => {
    let request: Request | undefined
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init)
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}\n\n',
      ])
    }

    await new OpencodeZenProvider(
      { type: 'opencodeZen', model: 'gpt-5.6-luna' },
      { apiKey: 'key' },
    ).translateSelection({ text: 'Hello', targetLanguage: 'zh-TW' }, { onDelta: () => undefined })

    expect(request?.url).toBe('https://opencode.ai/zen/go/v1/chat/completions')
    expect(await request?.json()).toMatchObject({ stream: true, thinking: { type: 'disabled' } })
  })

  test('rejects malformed SSE JSON and streamed API errors', async () => {
    globalThis.fetch = async () => sseResponse(['data: not-json\n\n'])

    await expect(
      createProvider().translateSelection(
        { text: 'Hello', targetLanguage: 'zh-TW' },
        { onDelta: () => undefined },
      ),
    ).rejects.toBeInstanceOf(ProviderJsonParseError)

    globalThis.fetch = async () =>
      sseResponse(['data: {"error":{"code":"rate_limit_exceeded","message":"Rate limited"}}\n\n'])

    const promise = createProvider().translateSelection(
      { text: 'Hello', targetLanguage: 'zh-TW' },
      { onDelta: () => undefined },
    )
    await expect(promise).rejects.toBeInstanceOf(ProviderHttpError)
    await expect(promise).rejects.toMatchObject({ status: 429 })
  })

  test('ignores null error frames', async () => {
    globalThis.fetch = async () =>
      sseResponse([
        'data: {"error":null,"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
        'data: {"error":null,"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      ])

    const deltas: string[] = []
    await createProvider().translateSelection(
      { text: 'Hello', targetLanguage: 'zh-TW' },
      { onDelta: (delta) => deltas.push(delta) },
    )

    expect(deltas).toEqual(['你好'])
  })

  test('rejects non-stop finish reasons without retrying', async () => {
    globalThis.fetch = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n',
      ])

    await expect(
      createProvider().translateSelection(
        { text: 'Hello', targetLanguage: 'zh-TW' },
        { onDelta: () => undefined },
      ),
    ).rejects.toMatchObject({
      name: ProviderSseError.name,
      message: 'OpenAI response finished with length',
    })
  })

  test('rejects empty and unfinished streams', async () => {
    globalThis.fetch = async () => sseResponse(['data: [DONE]\n\n'])
    await expect(
      createProvider().translateSelection(
        { text: 'Hello', targetLanguage: 'zh-TW' },
        { onDelta: () => undefined },
      ),
    ).rejects.toBeInstanceOf(ProviderJsonParseError)

    globalThis.fetch = async () =>
      sseResponse(['data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n'])
    await expect(
      createProvider().translateSelection(
        { text: 'Hello', targetLanguage: 'zh-TW' },
        { onDelta: () => undefined },
      ),
    ).rejects.toBeInstanceOf(ProviderJsonParseError)
  })
})
