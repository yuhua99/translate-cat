import { shouldDisableThinking } from '../../shared/providers'
import {
  CodexOAuthHttpError,
  extractAccountId,
  refreshCodexToken,
  type CodexTokens,
} from '../../shared/codex-oauth'
import {
  ProviderHttpError,
  ProviderJsonParseError,
  ProviderNetworkError,
  ProviderSseError,
} from './errors'
import { parseJsonObject } from './json'
import {
  createManualPrompt,
  createManualSystemPrompt,
  createSelectionPrompt,
  createSelectionSystemPrompt,
} from './prompts'
import { getSseError, isSseRateLimited, readProviderSse } from './stream'
import { getProviderSecret, setProviderSecret, type ProviderStorageArea } from './storage'
import type {
  AiProvider,
  ManualTranslateInput,
  ManualTranslateOutput,
  ProviderConfig,
  ProviderSecret,
  ProviderTestOutput,
  SelectionStreamOptions,
  SelectionTranslateInput,
} from './types'

const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const REFRESH_BUFFER_MS = 5 * 60 * 1_000

let refreshInFlight: Promise<CodexTokens> | undefined

async function waitWithSignal<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
  }

  const promise = start()
  if (!signal) return await promise

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)

    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

type SseEvent = {
  type?: unknown
  delta?: unknown
  response?: unknown
  error?: unknown
}

export class CodexProvider implements AiProvider {
  private auth: CodexTokens | undefined

  constructor(
    private readonly config: ProviderConfig,
    secret: ProviderSecret,
    private readonly secretStorage: ProviderStorageArea,
  ) {
    this.auth = secret.codexAuth
  }

  async translateManual(
    input: ManualTranslateInput,
    signal?: AbortSignal,
  ): Promise<ManualTranslateOutput> {
    const content = await this.complete(
      createManualPrompt(input),
      createManualSystemPrompt(),
      signal,
    )
    try {
      return parseJsonObject<ManualTranslateOutput>(content)
    } catch (error) {
      if (error instanceof ProviderJsonParseError) throw error
      throw new ProviderJsonParseError(
        `OpenAI Codex response is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async translateSelection(
    input: SelectionTranslateInput,
    options: SelectionStreamOptions,
  ): Promise<void> {
    let emittedDelta = false
    const content = await this.complete(
      createSelectionPrompt(input),
      createSelectionSystemPrompt(input),
      options.signal,
      (delta) => {
        if (delta) emittedDelta = true
        options.onDelta(delta)
      },
    )
    if (!emittedDelta) options.onDelta(content)
  }

  async testConnection(): Promise<ProviderTestOutput> {
    const content = await this.complete('Reply exactly: OK', 'Reply exactly: OK')
    const text = content.trim()
    if (text !== 'OK') {
      throw new Error(`Provider test failed: expected OK, got ${text}`)
    }
    return { ok: true }
  }

  private async complete(
    prompt: string,
    instructions: string,
    signal?: AbortSignal,
    onDelta?: (delta: string) => void,
  ): Promise<string> {
    await this.refreshIfNeeded(signal)

    try {
      return await this.request(prompt, instructions, signal, onDelta)
    } catch (error) {
      if (!(error instanceof ProviderHttpError) || error.status !== 401) {
        throw error
      }
    }

    await this.refreshAuth(signal)
    return await this.request(prompt, instructions, signal, onDelta)
  }

  private async request(
    prompt: string,
    instructions: string,
    signal?: AbortSignal,
    onDelta?: (delta: string) => void,
  ): Promise<string> {
    const auth = this.requireAuth()
    let response: Response
    try {
      response = await fetch(RESPONSES_URL, {
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          'chatgpt-account-id': auth.accountId,
          originator: 'translate-cat',
          'openai-beta': 'responses=experimental',
          accept: 'text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          ...(shouldDisableThinking(this.config) ? { reasoning: { effort: 'none' } } : {}),
          store: false,
          stream: true,
          instructions,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: prompt }],
            },
          ],
        }),
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new ProviderNetworkError(error instanceof Error ? error.message : String(error), {
        cause: error,
      })
    }

    if (!response.ok) {
      throw new ProviderHttpError(
        `OpenAI Codex request failed: ${response.status} ${await response.text()}`,
        response.status,
      )
    }

    return await parseSse(response, signal, onDelta)
  }

  private async refreshIfNeeded(signal?: AbortSignal): Promise<void> {
    const auth = this.requireAuth()
    if (auth.expiresAt <= Date.now() + REFRESH_BUFFER_MS) {
      await this.refreshAuth(signal)
    }
  }

  private async refreshAuth(signal?: AbortSignal): Promise<void> {
    this.auth = await waitWithSignal(
      () => refreshStoredAuth(this.secretStorage, this.requireAuth()),
      signal,
    )
  }

  private requireAuth(): CodexTokens {
    if (!this.auth) {
      throw new Error('Not signed in to OpenAI Codex')
    }
    return this.auth
  }
}

async function refreshStoredAuth(
  storage: ProviderStorageArea,
  current: CodexTokens,
): Promise<CodexTokens> {
  if (!refreshInFlight) {
    const refresh = refreshAndPersistAuth(storage, current)
    refreshInFlight = refresh
    try {
      return await refresh
    } finally {
      if (refreshInFlight === refresh) refreshInFlight = undefined
    }
  }

  return await refreshInFlight
}

async function refreshAndPersistAuth(
  storage: ProviderStorageArea,
  current: CodexTokens,
): Promise<CodexTokens> {
  const storedSecret = await getProviderSecret(storage, 'codex')
  const storedAuth = storedSecret.codexAuth
  if (
    storedAuth &&
    storedAuth.expiresAt > current.expiresAt &&
    storedAuth.expiresAt > Date.now() + REFRESH_BUFFER_MS
  ) {
    return storedAuth
  }

  const authToRefresh = storedAuth ?? current
  let refreshed: CodexTokens
  try {
    refreshed = await refreshCodexToken(authToRefresh.refreshToken)
  } catch (error) {
    if (error instanceof CodexOAuthHttpError) {
      throw new ProviderHttpError(error.message, error.status)
    }
    if (error instanceof TypeError || error instanceof DOMException) {
      throw new ProviderNetworkError(error instanceof Error ? error.message : String(error), {
        cause: error,
      })
    }
    throw error
  }

  const auth: CodexTokens = {
    ...refreshed,
    accountId: extractAccountId(refreshed.accessToken) ?? authToRefresh.accountId,
  }
  const latestSecret = await getProviderSecret(storage, 'codex')
  await setProviderSecret(storage, 'codex', { ...latestSecret, codexAuth: auth })
  return auth
}

async function parseSse(
  response: Response,
  signal?: AbortSignal,
  onDelta?: (delta: string) => void,
): Promise<string> {
  let content = ''
  const completed = await readProviderSse(response, 'OpenAI Codex', signal, (message) =>
    processSseEvent(
      message.data,
      (delta) => {
        content += delta
        onDelta?.(delta)
      },
      content.length > 0,
    ),
  )

  if (completed !== undefined) return content || completed

  throw new ProviderJsonParseError('OpenAI Codex SSE stream ended before response.completed')
}

function processSseEvent(
  data: string,
  append: (delta: string) => void,
  hasDeltas: boolean,
): string | undefined {
  let event: SseEvent
  try {
    event = JSON.parse(data) as SseEvent
  } catch (error) {
    throw new ProviderJsonParseError(
      `OpenAI Codex SSE event is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    throw new ProviderJsonParseError('OpenAI Codex SSE event is malformed')
  }

  if (event.type === 'response.output_text.delta') {
    if (typeof event.delta !== 'string') {
      throw new ProviderJsonParseError('OpenAI Codex SSE text delta is malformed')
    }
    append(event.delta)
    return undefined
  }

  if (event.type === 'response.completed' || event.type === 'response.done') {
    return hasDeltas ? '' : extractCompletedText(event.response)
  }

  if (
    event.type === 'response.failed' ||
    event.type === 'response.incomplete' ||
    event.type === 'response.error' ||
    event.type === 'error'
  ) {
    const error = getSseError(event.error ?? getResponseError(event.response))
    const message = `OpenAI Codex response failed: ${formatEventError(error)}`
    if (isSseRateLimited(error)) {
      throw new ProviderHttpError(message, 429)
    }
    throw new ProviderSseError(message)
  }

  return undefined
}

function extractCompletedText(response: unknown): string {
  if (!response || typeof response !== 'object') {
    throw new ProviderJsonParseError('OpenAI Codex completed response is malformed')
  }
  const output = (response as { output?: unknown }).output
  if (!Array.isArray(output)) {
    throw new ProviderJsonParseError('OpenAI Codex completed response is missing output')
  }

  const text = output
    .filter(
      (item): item is { type?: unknown; content?: unknown } => !!item && typeof item === 'object',
    )
    .filter((item) => item.type === 'message' && Array.isArray(item.content))
    .flatMap((item) => item.content as Array<{ type?: unknown; text?: unknown }>)
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')

  if (!text) {
    throw new ProviderJsonParseError('OpenAI Codex completed response is missing output text')
  }
  return text
}

function getResponseError(response: unknown): unknown {
  if (!response || typeof response !== 'object') return undefined
  const value = response as { error?: unknown; incomplete_details?: unknown }
  return value.error ?? value.incomplete_details
}

function formatEventError(error: { code?: string; message: string }): string {
  return error.code && error.code !== error.message
    ? `${error.code}: ${error.message}`
    : error.message
}
