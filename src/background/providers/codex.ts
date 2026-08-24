import {
  CodexOAuthHttpError,
  extractAccountId,
  refreshCodexToken,
  type CodexTokens,
} from '../../shared/codex-oauth'
import { ProviderHttpError, ProviderJsonParseError, ProviderNetworkError } from './errors'
import { parseJsonObject } from './json'
import { createManualPrompt, createManualSystemPrompt } from './prompts'
import { getProviderSecret, setProviderSecret, type ProviderStorageArea } from './storage'
import type {
  AiProvider,
  ManualTranslateInput,
  ManualTranslateOutput,
  ProviderConfig,
  ProviderSecret,
  ProviderTestOutput,
} from './types'

const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const REFRESH_BUFFER_MS = 5 * 60 * 1_000

let refreshInFlight: Promise<CodexTokens> | undefined

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
      createManualSystemPrompt(input),
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
  ): Promise<string> {
    await this.refreshIfNeeded(signal)

    try {
      return await this.request(prompt, instructions, signal)
    } catch (error) {
      if (!(error instanceof ProviderHttpError) || error.status !== 401) {
        throw error
      }
    }

    await this.refreshAuth(signal)
    return await this.request(prompt, instructions, signal)
  }

  private async request(
    prompt: string,
    instructions: string,
    signal?: AbortSignal,
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

    return await parseSse(response, signal)
  }

  private async refreshIfNeeded(signal?: AbortSignal): Promise<void> {
    const auth = this.requireAuth()
    if (auth.expiresAt <= Date.now() + REFRESH_BUFFER_MS) {
      await this.refreshAuth(signal)
    }
  }

  private async refreshAuth(signal?: AbortSignal): Promise<void> {
    this.auth = await refreshStoredAuth(this.secretStorage, this.requireAuth(), signal)
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
  signal?: AbortSignal,
): Promise<CodexTokens> {
  if (!refreshInFlight) {
    const refresh = refreshAndPersistAuth(storage, current, signal)
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
  signal?: AbortSignal,
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
    refreshed = await refreshCodexToken(authToRefresh.refreshToken, signal)
  } catch (error) {
    if (signal?.aborted) throw error
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

async function parseSse(response: Response, signal?: AbortSignal): Promise<string> {
  if (!response.body) {
    throw new ProviderJsonParseError('OpenAI Codex response did not include an SSE body')
  }

  let body: string
  try {
    body = await response.text()
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ProviderNetworkError(error instanceof Error ? error.message : String(error), {
      cause: error,
    })
  }

  let content = ''
  for (const rawLine of body.split('\n')) {
    const completed = processSseLine(
      rawLine.replace(/\r$/, ''),
      (delta) => {
        content += delta
      },
      content.length > 0,
    )
    if (completed !== undefined) return content || completed
  }

  throw new ProviderJsonParseError('OpenAI Codex SSE stream ended before response.completed')
}

function processSseLine(
  line: string,
  append: (delta: string) => void,
  hasDeltas: boolean,
): string | undefined {
  if (!line.startsWith('data: ')) return undefined

  let event: SseEvent
  try {
    event = JSON.parse(line.slice('data: '.length)) as SseEvent
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

  if (event.type === 'response.completed') {
    return hasDeltas ? '' : extractCompletedText(event.response)
  }

  if (event.type === 'response.failed' || event.type === 'error') {
    const error = getEventError(event.error)
    const message = `OpenAI Codex response failed: ${formatEventError(error)}`
    if (isRateLimited(error)) {
      throw new ProviderHttpError(message, 429)
    }
    throw new Error(message)
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

function getEventError(error: unknown): { code?: string; message: string } {
  if (typeof error === 'string') return { message: error }
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown; type?: unknown }
    let code: string | undefined
    if (typeof value.code === 'string') {
      code = value.code
    } else if (typeof value.type === 'string') {
      code = value.type
    }
    if (typeof value.message === 'string') return { code, message: value.message }
    if (code) return { code, message: code }
  }
  return { message: 'unknown error' }
}

function formatEventError(error: { code?: string; message: string }): string {
  return error.code && error.code !== error.message
    ? `${error.code}: ${error.message}`
    : error.message
}

function isRateLimited(error: { code?: string; message: string }): boolean {
  return (
    error.code?.toLowerCase().includes('rate_limit') ||
    /rate[ -]?limit(?:ed)?|too many requests|\b429\b/iu.test(error.message)
  )
}
