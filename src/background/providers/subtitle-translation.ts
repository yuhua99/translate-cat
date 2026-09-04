import { getCachedTranslations, setCachedTranslations } from '../cache'
import { ProviderHttpError, ProviderJsonParseError, ProviderNetworkError } from './errors'
import { createProvider } from './factory'
import { getProviderSecret, hasCredentials, type ProviderStores } from './storage'
import { getSettings } from '../settings-storage'
import {
  missingManualTranslationIds,
  validateManualTranslations,
} from '../../youtube/translation-validation'
import type { ProviderConfig, ProviderRequestContext, ProviderSecret, ProviderType } from './types'
import type {
  SelectionTranslationRequest,
  TranslateSubtitleMessage,
  TranslateSubtitleResult,
  TranslationError,
} from '../../shared/messages'

const MAX_RETRIES = 2
const RETRY_BASE_MS = 1_000

function isFatalError(error: unknown): boolean {
  return error instanceof ProviderHttpError && (error.status === 401 || error.status === 403)
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof ProviderHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500
  }
  return (
    error instanceof ProviderNetworkError ||
    error instanceof SyntaxError ||
    error instanceof ProviderJsonParseError
  )
}

function backoffMs(attempt: number): number {
  return RETRY_BASE_MS * Math.pow(2, attempt)
}

function abortedError(): TranslationError {
  return { ok: false, error: 'aborted', fatal: false }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    signal?.addEventListener('abort', onAbort)
  })
}

async function withRetry<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
  onRetry?: () => void,
): Promise<{ ok: true; data: T } | TranslationError> {
  let lastError: unknown

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (signal?.aborted) return abortedError()
    try {
      const data = await fn()
      return { ok: true, data }
    } catch (error) {
      lastError = error

      if (signal?.aborted) return abortedError()

      if (isFatalError(error)) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          fatal: true,
        }
      }

      if (!isRetryableError(error) || attempt >= MAX_RETRIES) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          fatal: false,
        }
      }

      onRetry?.()
      await abortableDelay(backoffMs(attempt), signal)
      if (signal?.aborted) return abortedError()
    }
  }

  return {
    ok: false,
    error: lastError instanceof Error ? lastError.message : String(lastError),
    fatal: false,
  }
}

export async function translateSubtitleMessage(
  message: TranslateSubtitleMessage,
  stores: ProviderStores,
  signal?: AbortSignal,
  requestContext?: ProviderRequestContext,
): Promise<TranslateSubtitleResult | TranslationError> {
  const providerConfig = message.provider
  const cacheKey = createWindowCacheKey(message)
  const cached = await getCachedTranslations(stores.local, cacheKey)
  const requestedIds = message.items.map((item) => item.id)

  if (cached && cached.length > 0) {
    return { ok: true, translations: validateManualTranslations(requestedIds, cached) }
  }

  const provider = await resolveProvider(stores, providerConfig, requestContext)
  const providerItems = message.items.map((item, index) => ({ ...item, id: String(index) }))
  const providerIdToSourceId = new Map(
    providerItems.map((item, index) => [item.id, message.items[index]?.id]),
  )

  const result = await withRetry(
    () =>
      provider.translateManual(
        {
          items: providerItems,
          targetLanguage: message.targetLanguage,
          contextBefore: message.contextBefore,
          contextAfter: message.contextAfter,
        },
        signal,
      ),
    signal,
  )

  if (!result.ok) return result

  const providerTranslations = validateManualTranslations(
    providerItems.map((item) => item.id),
    result.data.translations,
  )
  const translations = providerTranslations.flatMap((item) => {
    const sourceId = providerIdToSourceId.get(item.id)
    return sourceId ? [{ id: sourceId, text: item.text }] : []
  })

  const missingIds = missingManualTranslationIds(requestedIds, translations)
  if (missingIds.length > 0) {
    console.warn(`[yt-translator] Missing translations for ids: ${missingIds.join(', ')}`)
  }

  if (missingIds.length === 0) {
    await setCachedTranslations(stores.local, cacheKey, translations)
  }

  return { ok: true, translations }
}

function createWindowCacheKey(message: TranslateSubtitleMessage): string {
  const first = message.items[0]?.startMs ?? 0
  const windowStartMs = Math.floor(first / 30_000) * 30_000
  const sourceHash = hashString(message.items.map((item) => `${item.id}:${item.text}`).join('\n'))
  return [
    'v1',
    message.videoId,
    message.trackId,
    message.targetLanguage,
    message.provider.type,
    message.provider.model,
    windowStartMs,
    sourceHash,
  ].join('|')
}

function hashString(input: string): string {
  let hash = 0
  for (let i = 0; i < input.length; i += 1) {
    hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}

async function resolveProvider(
  stores: ProviderStores,
  config: ProviderConfig,
  requestContext?: ProviderRequestContext,
) {
  const secret = await getProviderSecret(stores.local, config.type)
  return createProvider(config, secret, stores.local, requestContext)
}

export interface SelectionTranslationErrorMessages {
  missingApiKey: (providerType: ProviderType) => string
  notSignedInCodex: () => string
  noTranslation: () => string
}

export interface SelectionTranslationStreamOptions {
  signal?: AbortSignal
  onDelta: (text: string) => void
  onReset: () => void
  errors: SelectionTranslationErrorMessages
}

export async function resolveActiveProvider(
  stores: ProviderStores,
  errors: SelectionTranslationErrorMessages,
): Promise<{ ok: true; config: ProviderConfig; secret: ProviderSecret } | TranslationError> {
  const settings = await getSettings(stores.sync)
  const config = settings.provider
  const secret = await getProviderSecret(stores.local, config.type)

  if (!hasCredentials(config.type, secret)) {
    return {
      ok: false,
      error:
        config.type === 'codex' ? errors.notSignedInCodex() : errors.missingApiKey(config.type),
      fatal: false,
    }
  }
  return { ok: true, config, secret }
}

export async function translateSelectionMessage(
  request: SelectionTranslationRequest,
  stores: ProviderStores,
  options: SelectionTranslationStreamOptions,
  requestContext?: ProviderRequestContext,
): Promise<{ ok: true } | TranslationError> {
  try {
    if (options.signal?.aborted) return abortedError()

    const activeProvider = await resolveActiveProvider(stores, options.errors)
    if (!activeProvider.ok) return activeProvider

    const provider = createProvider(
      activeProvider.config,
      activeProvider.secret,
      stores.local,
      requestContext,
    )
    let text = ''
    const result = await withRetry(
      () =>
        provider.translateSelection(
          { text: request.text, targetLanguage: request.targetLanguage },
          {
            signal: options.signal,
            onDelta: (delta) => {
              if (options.signal?.aborted) return
              text += delta
              options.onDelta(delta)
            },
          },
        ),
      options.signal,
      () => {
        if (!text) return
        text = ''
        options.onReset()
      },
    )

    if (!result.ok) return result
    if (!text.trim()) {
      return { ok: false, error: options.errors.noTranslation(), fatal: false }
    }
    return { ok: true }
  } catch (error) {
    if (options.signal?.aborted) return abortedError()
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      fatal: false,
    }
  }
}
