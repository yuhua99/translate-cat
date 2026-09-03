import { afterEach, describe, expect, test } from 'bun:test'
import { CodexProvider } from '../../src/background/providers/codex'
import { ProviderJsonParseError } from '../../src/background/providers/errors'
import {
  createSelectionPrompt,
  createSelectionSystemPrompt,
} from '../../src/background/providers/prompts'
import type { ProviderStorageArea } from '../../src/background/providers/storage'
import { sseEvents } from '../helpers/sse'

const originalFetch = globalThis.fetch
const encoder = new TextEncoder()

afterEach(() => {
  globalThis.fetch = originalFetch
})

function createCodexAccessToken(accountId = 'account-123'): string {
  const payload = btoa(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  )
  return `header.${payload}.signature`
}

function createProvider(): CodexProvider {
  return new CodexProvider(
    { type: 'codex', model: 'gpt-5.4-mini' },
    {
      codexAuth: {
        accessToken: createCodexAccessToken(),
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1_000,
        accountId: 'account-123',
      },
    },
    createStorage(),
  )
}

function createStorage(): ProviderStorageArea {
  return {
    async get(keys: string | string[]): Promise<Record<string, unknown>> {
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, undefined]))
      }
      return {}
    },
    async set(): Promise<void> {},
  }
}

describe('CodexProvider selection stream', () => {
  test('keeps manual translation JSON accumulation', async () => {
    globalThis.fetch = async () =>
      sseEvents([
        { type: 'response.output_text.delta', delta: '{"translations":[{"id":"a",' },
        { type: 'response.output_text.delta', delta: '"text":"你好"}]}' },
        { type: 'response.completed' },
      ])

    await expect(
      createProvider().translateManual({
        targetLanguage: 'zh-TW',
        items: [{ id: 'a', text: 'Hello', startMs: 0 }],
      }),
    ).resolves.toEqual({ translations: [{ id: 'a', text: '你好' }] })
  })

  test('sends the selection request and emits text deltas before response.done', async () => {
    let request: Request | undefined
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    let resolveFetch: () => void = () => undefined
    let resolveDelta: () => void = () => undefined
    const fetched = new Promise<void>((resolve) => {
      resolveFetch = resolve
    })
    const receivedDelta = new Promise<void>((resolve) => {
      resolveDelta = resolve
    })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
    })
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init)
      resolveFetch()
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }

    const selection = { text: 'Hello', targetLanguage: 'zh-TW' }
    const deltas: string[] = []
    const completed = createProvider().translateSelection(selection, {
      onDelta(delta) {
        deltas.push(delta)
        resolveDelta()
      },
    })
    await fetched
    streamController?.enqueue(
      encoder.encode(
        'data: {"type":"response.reasoning.delta","delta":"hidden"}\n\ndata: {"type":"response.output_text.',
      ),
    )
    streamController?.enqueue(encoder.encode('delta","delta":"你好"}\n\n'))

    await receivedDelta
    expect(deltas).toEqual(['你好'])
    expect(request?.headers.get('authorization')).toBe(`Bearer ${createCodexAccessToken()}`)
    expect(request?.headers.get('chatgpt-account-id')).toBe('account-123')
    expect(request?.headers.get('originator')).toBe('translate-cat')
    expect(request?.headers.get('openai-beta')).toBe('responses=experimental')
    expect(request?.headers.get('accept')).toBe('text/event-stream')
    expect(await request?.json()).toMatchObject({
      model: 'gpt-5.4-mini',
      reasoning: { effort: 'none' },
      store: false,
      stream: true,
      instructions: createSelectionSystemPrompt(selection),
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: createSelectionPrompt(selection) }],
        },
      ],
    })

    streamController?.enqueue(encoder.encode('data: {"type":"response.done"}\n\n'))
    streamController?.close()
    await expect(completed).resolves.toBeUndefined()
  })

  test('emits completed response text when the stream has no text deltas', async () => {
    globalThis.fetch = async () =>
      sseEvents([
        {
          type: 'response.completed',
          response: {
            output: [{ type: 'message', content: [{ type: 'output_text', text: '你好' }] }],
          },
        },
      ])

    const deltas: string[] = []
    await createProvider().translateSelection(
      { text: 'Hello', targetLanguage: 'zh-TW' },
      { onDelta: (delta) => deltas.push(delta) },
    )

    expect(deltas).toEqual(['你好'])
  })

  test('emits completed response text after an empty text delta', async () => {
    globalThis.fetch = async () =>
      sseEvents([
        { type: 'response.output_text.delta', delta: '' },
        {
          type: 'response.completed',
          response: {
            output: [{ type: 'message', content: [{ type: 'output_text', text: '你好' }] }],
          },
        },
      ])

    const deltas: string[] = []
    await createProvider().translateSelection(
      { text: 'Hello', targetLanguage: 'zh-TW' },
      { onDelta: (delta) => deltas.push(delta) },
    )

    expect(deltas).toEqual(['', '你好'])
  })

  test('rejects failed, incomplete, and error terminal events', async () => {
    const events = [
      { event: { type: 'response.failed', error: { message: 'failed' } }, message: 'failed' },
      {
        event: {
          type: 'response.incomplete',
          response: { incomplete_details: { type: 'max_output', message: 'incomplete' } },
        },
        message: 'max_output: incomplete',
      },
      { event: { type: 'error', error: { message: 'error' } }, message: 'error' },
    ]

    for (const { event, message } of events) {
      globalThis.fetch = async () => sseEvents([event])
      await expect(
        createProvider().translateSelection(
          { text: 'Hello', targetLanguage: 'zh-TW' },
          { onDelta() {} },
        ),
      ).rejects.toThrow(`OpenAI Codex response failed: ${message}`)
    }
  })

  test('rejects malformed SSE and premature EOF', async () => {
    const responses = [new Response('data: not-json\n\n'), sseEvents([])]

    for (const response of responses) {
      globalThis.fetch = async () => response
      await expect(
        createProvider().translateSelection(
          { text: 'Hello', targetLanguage: 'zh-TW' },
          { onDelta() {} },
        ),
      ).rejects.toBeInstanceOf(ProviderJsonParseError)
    }
  })
})
