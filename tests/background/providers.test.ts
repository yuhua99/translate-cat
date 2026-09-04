import { afterEach, describe, expect, test } from 'bun:test'
import { AnthropicProvider } from '../../src/background/providers/anthropic'
import { CodexProvider } from '../../src/background/providers/codex'
import {
  ProviderHttpError,
  ProviderJsonParseError,
  ProviderNetworkError,
} from '../../src/background/providers/errors'
import { GeminiProvider } from '../../src/background/providers/gemini'
import { parseJsonObject } from '../../src/background/providers/json'
import { TOKEN_URL } from '../../src/shared/codex-oauth'
import { OpenAiProvider } from '../../src/background/providers/openai'
import { OpencodeZenProvider } from '../../src/background/providers/opencode-zen'
import {
  getProviderSecret,
  setProviderSecret,
  type ProviderStorageArea,
} from '../../src/background/providers/storage'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function createCodexAccessToken(accountId = 'account-123'): string {
  const payload = btoa(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  )
  return `header.${payload}.signature`
}

function createCodexAuth(expiresAt = Date.now() + 60 * 60 * 1_000) {
  return {
    accessToken: createCodexAccessToken(),
    refreshToken: 'refresh-token',
    expiresAt,
    accountId: 'account-123',
  }
}

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function createMemoryStorage(
  initial: Record<string, unknown> = {},
): ProviderStorageArea & { data: Record<string, unknown> } {
  const data = { ...initial }

  return {
    data,
    async get(keys: string | string[]): Promise<Record<string, unknown>> {
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, data[key]]))
      }
      return { [keys]: data[keys] }
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
  test('stores API secrets locally by provider type', async () => {
    const sync = createMemoryStorage()
    const local = createMemoryStorage()
    await setProviderSecret(local, 'openai', { apiKey: 'secret-key' })

    await expect(getProviderSecret(local, 'openai')).resolves.toEqual({ apiKey: 'secret-key' })
    expect(JSON.stringify(sync.data)).not.toContain('secret-key')
  })

  test('preserves concurrent writes for different providers', async () => {
    let releaseFirstSet: (() => void) | undefined
    let firstSetStarted: (() => void) | undefined
    const data: Record<string, unknown> = {}
    let setCalls = 0
    const storage: ProviderStorageArea = {
      async get(key) {
        return { [key as string]: data[key as string] }
      },
      async set(items) {
        setCalls += 1
        if (setCalls === 1) {
          firstSetStarted?.()
          await new Promise<void>((resolve) => {
            releaseFirstSet = resolve
          })
        }
        Object.assign(data, items)
      },
    }

    const openaiWrite = setProviderSecret(storage, 'openai', { apiKey: 'openai-key' })
    await new Promise<void>((resolve) => {
      firstSetStarted = resolve
    })
    const geminiWrite = setProviderSecret(storage, 'gemini', { apiKey: 'gemini-key' })
    releaseFirstSet?.()
    await Promise.all([openaiWrite, geminiWrite])

    await expect(getProviderSecret(storage, 'openai')).resolves.toEqual({ apiKey: 'openai-key' })
    await expect(getProviderSecret(storage, 'gemini')).resolves.toEqual({ apiKey: 'gemini-key' })
  })

  test('continues queued writes after a write failure', async () => {
    const failure = new Error('write failed')
    let setCalls = 0
    const storage = createMemoryStorage()
    storage.set = async (items) => {
      setCalls += 1
      if (setCalls === 1) throw failure
      Object.assign(storage.data, items)
    }

    await expect(setProviderSecret(storage, 'openai', { apiKey: 'openai-key' })).rejects.toBe(
      failure,
    )
    await setProviderSecret(storage, 'gemini', { apiKey: 'gemini-key' })

    await expect(getProviderSecret(storage, 'gemini')).resolves.toEqual({ apiKey: 'gemini-key' })
  })
})

describe('CodexProvider', () => {
  test('sends a streamed Responses API request and parses translation deltas', async () => {
    let request: Request | undefined
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init)
      return sse([
        { type: 'response.output_text.delta', delta: '{"translations":[{"id":"a",' },
        { type: 'response.output_text.delta', delta: '"text":"你好"}]}' },
        { type: 'response.completed' },
      ])
    }

    const provider = new CodexProvider(
      { type: 'codex', model: 'gpt-5.4-mini' },
      { codexAuth: createCodexAuth() },
      createMemoryStorage(),
    )
    const result = await provider.translateManual({
      targetLanguage: 'Traditional Chinese',
      items: [{ id: 'a', text: 'Hello', startMs: 0 }],
    })

    expect(request?.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(request?.headers.get('authorization')).toBe(`Bearer ${createCodexAuth().accessToken}`)
    expect(request?.headers.get('chatgpt-account-id')).toBe('account-123')
    expect(request?.headers.get('originator')).toBe('translate-cat')
    expect(request?.headers.get('openai-beta')).toBe('responses=experimental')
    expect(request?.headers.get('accept')).toBe('text/event-stream')
    expect(await request?.json()).toMatchObject({
      model: 'gpt-5.4-mini',
      reasoning: { effort: 'none' },
      store: false,
      stream: true,
      input: [{ type: 'message', role: 'user' }],
    })
    expect(result).toEqual({ translations: [{ id: 'a', text: '你好' }] })
  })

  test('classifies rate-limited SSE failures as ProviderHttpError 429', async () => {
    globalThis.fetch = async () =>
      sse([
        {
          type: 'response.failed',
          error: { code: 'rate_limit_exceeded', message: 'Rate limit exceeded' },
        },
      ])

    const provider = new CodexProvider(
      { type: 'codex', model: 'gpt-5.4-mini' },
      { codexAuth: createCodexAuth() },
      createMemoryStorage(),
    )

    const promise = provider.translateManual({
      targetLanguage: 'zh-TW',
      items: [{ id: 'a', text: 'Hello', startMs: 0 }],
    })
    await expect(promise).rejects.toBeInstanceOf(ProviderHttpError)
    await expect(promise).rejects.toMatchObject({ status: 429 })
  })

  test('classifies deterministic SSE failures as plain Error', async () => {
    globalThis.fetch = async () =>
      sse([
        {
          type: 'response.failed',
          error: { code: 'invalid_model', message: 'Model is unavailable' },
        },
      ])

    const provider = new CodexProvider(
      { type: 'codex', model: 'gpt-5.4-mini' },
      { codexAuth: createCodexAuth() },
      createMemoryStorage(),
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
    expect((caught as Error).message).toContain('invalid_model')
  })

  test('throws ProviderHttpError on HTTP failures', async () => {
    globalThis.fetch = async () => new Response('server error', { status: 500 })

    const provider = new CodexProvider(
      { type: 'codex', model: 'gpt-5.4-mini' },
      { codexAuth: createCodexAuth() },
      createMemoryStorage(),
    )

    const promise = provider.translateManual({
      targetLanguage: 'zh-TW',
      items: [{ id: 'a', text: 'Hello', startMs: 0 }],
    })
    await expect(promise).rejects.toMatchObject({ status: 500 })
  })

  test('throws ProviderNetworkError on fetch rejection', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('network down')
    }

    const provider = new CodexProvider(
      { type: 'codex', model: 'gpt-5.4-mini' },
      { codexAuth: createCodexAuth() },
      createMemoryStorage(),
    )

    await expect(
      provider.translateManual({
        targetLanguage: 'zh-TW',
        items: [{ id: 'a', text: 'Hello', startMs: 0 }],
      }),
    ).rejects.toBeInstanceOf(ProviderNetworkError)
  })

  test('refreshes expired credentials and persists them through injected storage', async () => {
    const storage = createMemoryStorage()
    const auth = createCodexAuth(Date.now())
    await setProviderSecret(storage, 'codex', { codexAuth: auth })
    globalThis.fetch = async (input) => {
      if (String(input) === TOKEN_URL) {
        return Response.json({
          access_token: createCodexAccessToken(),
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        })
      }
      return sse([
        {
          type: 'response.output_text.delta',
          delta: '{"translations":[{"id":"a","text":"你好"}]}',
        },
        { type: 'response.completed' },
      ])
    }

    const provider = new CodexProvider(
      { type: 'codex', model: 'gpt-5.4-mini' },
      { codexAuth: auth },
      storage,
    )
    await provider.translateManual({
      targetLanguage: 'zh-TW',
      items: [{ id: 'a', text: 'Hello', startMs: 0 }],
    })

    await expect(getProviderSecret(storage, 'codex')).resolves.toMatchObject({
      codexAuth: { refreshToken: 'new-refresh-token', accountId: 'account-123' },
    })
  })

  test('serializes concurrent expired-token refreshes', async () => {
    const storage = createMemoryStorage()
    const auth = createCodexAuth(Date.now())
    await setProviderSecret(storage, 'codex', { codexAuth: auth })
    let refreshCalls = 0
    globalThis.fetch = async (input) => {
      if (String(input) === TOKEN_URL) {
        refreshCalls += 1
        return Response.json({
          access_token: createCodexAccessToken(),
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        })
      }
      return sse([
        {
          type: 'response.output_text.delta',
          delta: '{"translations":[{"id":"a","text":"你好"}]}',
        },
        { type: 'response.completed' },
      ])
    }

    const input = {
      targetLanguage: 'zh-TW',
      items: [{ id: 'a', text: 'Hello', startMs: 0 }],
    }
    await Promise.all([
      new CodexProvider(
        { type: 'codex', model: 'gpt-5.4-mini' },
        { codexAuth: auth },
        storage,
      ).translateManual(input),
      new CodexProvider(
        { type: 'codex', model: 'gpt-5.4-mini' },
        { codexAuth: auth },
        storage,
      ).translateManual(input),
    ])

    expect(refreshCalls).toBe(1)
  })

  test('keeps shared refresh running when one caller aborts', async () => {
    const storage = createMemoryStorage()
    const auth = createCodexAuth(Date.now())
    await setProviderSecret(storage, 'codex', { codexAuth: auth })
    let refreshCalls = 0
    let responseCalls = 0
    let refreshSignal: AbortSignal | null | undefined
    let releaseRefresh: (response: Response) => void = () => {}
    let refreshStarted: () => void = () => {}
    const refreshResponse = new Promise<Response>((resolve) => {
      releaseRefresh = resolve
    })
    const refreshStartedPromise = new Promise<void>((resolve) => {
      refreshStarted = resolve
    })
    globalThis.fetch = async (input, init) => {
      if (String(input) === TOKEN_URL) {
        refreshCalls += 1
        refreshSignal = init?.signal
        refreshStarted()
        return await refreshResponse
      }
      responseCalls += 1
      return sse([
        {
          type: 'response.output_text.delta',
          delta: '{"translations":[{"id":"a","text":"你好"}]}',
        },
        { type: 'response.completed' },
      ])
    }

    const input = {
      targetLanguage: 'zh-TW',
      items: [{ id: 'a', text: 'Hello', startMs: 0 }],
    }
    const controller = new AbortController()
    const aborted = new DOMException('aborted', 'AbortError')
    const first = new CodexProvider(
      { type: 'codex', model: 'gpt-5.4-mini' },
      { codexAuth: auth },
      storage,
    ).translateManual(input, controller.signal)
    await refreshStartedPromise
    const second = new CodexProvider(
      { type: 'codex', model: 'gpt-5.4-mini' },
      { codexAuth: auth },
      storage,
    ).translateManual(input)

    controller.abort(aborted)
    await expect(first).rejects.toBe(aborted)
    expect(refreshCalls).toBe(1)
    expect(refreshSignal).toBeDefined()
    expect(refreshSignal).not.toBe(controller.signal)

    releaseRefresh(
      Response.json({
        access_token: createCodexAccessToken(),
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      }),
    )

    await expect(second).resolves.toEqual({ translations: [{ id: 'a', text: '你好' }] })
    expect(responseCalls).toBe(1)
    await expect(getProviderSecret(storage, 'codex')).resolves.toMatchObject({
      codexAuth: { refreshToken: 'new-refresh-token' },
    })
  })

  test('does not refresh for a pre-aborted caller', async () => {
    const auth = createCodexAuth(Date.now())
    const controller = new AbortController()
    const aborted = new DOMException('aborted', 'AbortError')
    controller.abort(aborted)
    let fetchCalls = 0
    globalThis.fetch = async () => {
      fetchCalls += 1
      return new Response('unexpected request')
    }

    const provider = new CodexProvider(
      { type: 'codex', model: 'gpt-5.4-mini' },
      { codexAuth: auth },
      createMemoryStorage(),
    )

    await expect(
      provider.translateManual(
        { targetLanguage: 'zh-TW', items: [{ id: 'a', text: 'Hello', startMs: 0 }] },
        controller.signal,
      ),
    ).rejects.toBe(aborted)
    expect(fetchCalls).toBe(0)
  })

  test('converts refresh HTTP failures to ProviderHttpError', async () => {
    const auth = createCodexAuth(Date.now())
    globalThis.fetch = async () => new Response('invalid grant', { status: 400 })

    const provider = new CodexProvider(
      { type: 'codex', model: 'gpt-5.4-mini' },
      { codexAuth: auth },
      createMemoryStorage(),
    )

    const promise = provider.translateManual({
      targetLanguage: 'zh-TW',
      items: [{ id: 'a', text: 'Hello', startMs: 0 }],
    })
    await expect(promise).rejects.toBeInstanceOf(ProviderHttpError)
    await expect(promise).rejects.toMatchObject({ status: 400 })
  })

  test('converts refresh network failures to ProviderNetworkError', async () => {
    const auth = createCodexAuth(Date.now())
    globalThis.fetch = async () => {
      throw new TypeError('network down')
    }

    const provider = new CodexProvider(
      { type: 'codex', model: 'gpt-5.4-mini' },
      { codexAuth: auth },
      createMemoryStorage(),
    )

    await expect(
      provider.translateManual({
        targetLanguage: 'zh-TW',
        items: [{ id: 'a', text: 'Hello', startMs: 0 }],
      }),
    ).rejects.toBeInstanceOf(ProviderNetworkError)
  })

  test('refreshes once and retries after a 401 response', async () => {
    const auth = createCodexAuth()
    let responseCalls = 0
    let refreshCalls = 0
    globalThis.fetch = async (input) => {
      if (String(input) === TOKEN_URL) {
        refreshCalls += 1
        return Response.json({
          access_token: createCodexAccessToken(),
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        })
      }
      responseCalls += 1
      if (responseCalls === 1) return new Response('unauthorized', { status: 401 })
      return sse([
        {
          type: 'response.output_text.delta',
          delta: '{"translations":[{"id":"a","text":"你好"}]}',
        },
        { type: 'response.completed' },
      ])
    }

    const provider = new CodexProvider(
      { type: 'codex', model: 'gpt-5.4-mini' },
      { codexAuth: auth },
      createMemoryStorage(),
    )
    await provider.translateManual({
      targetLanguage: 'zh-TW',
      items: [{ id: 'a', text: 'Hello', startMs: 0 }],
    })

    expect(responseCalls).toBe(2)
    expect(refreshCalls).toBe(1)
  })

  test('propagates aborts', async () => {
    const controller = new AbortController()
    const reason = new DOMException('aborted', 'AbortError')
    controller.abort(reason)
    globalThis.fetch = async () => {
      throw reason
    }

    const provider = new CodexProvider(
      { type: 'codex', model: 'gpt-5.4-mini' },
      { codexAuth: createCodexAuth() },
      createMemoryStorage(),
    )

    await expect(
      provider.translateManual(
        { targetLanguage: 'zh-TW', items: [{ id: 'a', text: 'Hello', startMs: 0 }] },
        controller.signal,
      ),
    ).rejects.toBe(reason)
  })
})

describe('OpenAiProvider', () => {
  test('tests connection with tiny request', async () => {
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({
        choices: [{ message: { content: 'OK' } }],
      })
    }

    const provider = new OpenAiProvider(
      { type: 'openai', model: 'gpt-4.1-mini' },
      { apiKey: 'key' },
    )

    await expect(provider.testConnection()).resolves.toEqual({ ok: true })
    expect(requestBody?.max_completion_tokens).toBe(40)
    expect(requestBody).not.toHaveProperty('response_format')
    expect(requestBody).not.toHaveProperty('reasoning_effort')
  })

  test('sends chat completion request and parses manual translations', async () => {
    let request: Request | undefined
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init)
      return Response.json({
        choices: [{ message: { content: '{"translations":[{"id":"a","text":"你好"}]}' } }],
      })
    }

    const provider = new OpenAiProvider(
      { type: 'openai', model: 'gpt-5.6-luna' },
      { apiKey: 'key' },
    )
    const result = await provider.translateManual({
      targetLanguage: 'Traditional Chinese',
      items: [{ id: 'a', text: 'Hello', startMs: 0 }],
    })

    expect(request?.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(request?.headers.get('authorization')).toBe('Bearer key')
    const requestBody = await request?.json()
    expect(requestBody).toMatchObject({ reasoning_effort: 'none' })
    expect(requestBody).not.toHaveProperty('temperature')
    expect(result).toEqual({
      translations: [{ id: 'a', text: '你好' }],
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
      { type: 'opencodeZen', model: 'gpt-5.6-luna' },
      { apiKey: 'key' },
      { sessionId: 'manual-session-123' },
    )
    await provider.translateManual({
      targetLanguage: 'zh-TW',
      items: [{ id: 'a', text: 'Hello', startMs: 0 }],
    })

    expect(request?.url).toBe('https://opencode.ai/zen/go/v1/chat/completions')
    expect(request?.headers.get('x-opencode-session')).toBe('manual-session-123')
    expect(await request?.json()).toMatchObject({ thinking: { type: 'disabled' } })
  })

  test('uses session context for connection tests', async () => {
    let request: Request | undefined
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init)
      return Response.json({ choices: [{ message: { content: 'OK' } }] })
    }

    const provider = new OpencodeZenProvider(
      { type: 'opencodeZen', model: 'gpt-5.6-luna' },
      { apiKey: 'key' },
      { sessionId: 'connection-session-123' },
    )

    await expect(provider.testConnection()).resolves.toEqual({
      ok: true,
    })
    expect(request?.headers.get('x-opencode-session')).toBe('connection-session-123')
  })

  test('omits thinking settings for custom models', async () => {
    let request: Request | undefined
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init)
      return Response.json({
        choices: [{ message: { content: '{"translations":[{"id":"a","text":"你好"}]}' } }],
      })
    }

    const provider = new OpencodeZenProvider(
      { type: 'opencodeZen', model: 'custom-model' },
      { apiKey: 'key' },
    )
    await provider.translateManual({
      targetLanguage: 'zh-TW',
      items: [{ id: 'a', text: 'Hello', startMs: 0 }],
    })

    expect(await request?.json()).not.toHaveProperty('thinking')
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
      })
    }

    const provider = new GeminiProvider(
      { type: 'gemini', model: 'gemini-2.5-flash' },
      { apiKey: 'key' },
    )

    await expect(provider.testConnection()).resolves.toEqual({ ok: true })
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
    expect(requestBody).not.toHaveProperty('thinkingConfig')
    expect(result).toEqual({
      translations: [{ id: 'a', text: '你好' }],
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
      })
    }

    const provider = new AnthropicProvider(
      { type: 'anthropic', model: 'claude-haiku-4-5' },
      { apiKey: 'key' },
    )

    await expect(provider.testConnection()).resolves.toEqual({ ok: true })
    expect(requestBody?.max_tokens).toBe(40)
    expect(requestBody).toMatchObject({ thinking: { type: 'disabled' } })
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
