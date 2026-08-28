import { afterEach, describe, expect, test } from 'bun:test'
import { AnthropicProvider } from '../../src/background/providers/anthropic'
import {
  ProviderHttpError,
  ProviderJsonParseError,
  ProviderSseError,
} from '../../src/background/providers/errors'
import { sseResponse } from '../helpers/sse'

const originalFetch = globalThis.fetch

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function createProvider(): AnthropicProvider {
  return new AnthropicProvider({ type: 'anthropic', model: 'claude-haiku-4-5' }, { apiKey: 'key' })
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('AnthropicProvider selection streaming', () => {
  test('sends a plain-text streamed request and emits only text deltas from split frames', async () => {
    let request: Request | undefined
    let receivedSignal: AbortSignal | null | undefined
    const stream = [
      frame('message_start', { type: 'message_start' }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'ignored' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '你' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '好' },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('')
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init)
      receivedSignal = init?.signal
      return sseResponse([stream.slice(0, 83), stream.slice(83, 197), stream.slice(197)])
    }

    const controller = new AbortController()
    const deltas: string[] = []
    await createProvider().translateSelection(
      { text: 'Hello world', targetLanguage: 'zh-TW' },
      { signal: controller.signal, onDelta: (text) => deltas.push(text) },
    )

    expect(request?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(request?.headers.get('x-api-key')).toBe('key')
    expect(request?.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(await request?.json()).toMatchObject({
      model: 'claude-haiku-4-5',
      max_tokens: 8192,
      temperature: 0,
      stream: true,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user' }],
    })
    expect(receivedSignal).toBe(controller.signal)
    expect(deltas).toEqual(['你', '好'])
  })

  test('classifies event and data provider errors', async () => {
    globalThis.fetch = async () =>
      sseResponse([
        frame('error', {
          type: 'error',
          error: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
        }),
      ])

    await expect(
      createProvider().translateSelection(
        { text: 'Hello', targetLanguage: 'zh-TW' },
        { onDelta: () => {} },
      ),
    ).rejects.toMatchObject({ name: ProviderHttpError.name, status: 429 })

    globalThis.fetch = async () =>
      sseResponse([
        frame('message', {
          type: 'error',
          error: { type: 'overloaded_error', message: 'Try again later' },
        }),
      ])

    await expect(
      createProvider().translateSelection(
        { text: 'Hello', targetLanguage: 'zh-TW' },
        { onDelta: () => {} },
      ),
    ).rejects.toMatchObject({ name: ProviderHttpError.name, status: 529 })
  })

  test('rejects max_tokens message deltas without retrying', async () => {
    globalThis.fetch = async () =>
      sseResponse([
        frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
      ])

    const translation = createProvider().translateSelection(
      { text: 'Hello', targetLanguage: 'zh-TW' },
      { onDelta: () => {} },
    )

    await expect(translation).rejects.toBeInstanceOf(ProviderSseError)
    await expect(translation).rejects.toThrow('Anthropic response truncated at max_tokens limit')
  })

  test('rejects malformed and incomplete streams as retryable JSON errors', async () => {
    globalThis.fetch = async () => sseResponse(['event: message_start\ndata: not json\n\n'])
    await expect(
      createProvider().translateSelection(
        { text: 'Hello', targetLanguage: 'zh-TW' },
        { onDelta: () => {} },
      ),
    ).rejects.toBeInstanceOf(ProviderJsonParseError)

    globalThis.fetch = async () =>
      sseResponse([
        frame('content_block_delta', {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'partial' },
        }),
      ])
    await expect(
      createProvider().translateSelection(
        { text: 'Hello', targetLanguage: 'zh-TW' },
        { onDelta: () => {} },
      ),
    ).rejects.toThrow('Anthropic SSE stream ended before message_stop')
  })
})
