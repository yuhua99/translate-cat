import { getCachedTranslations, setCachedTranslations } from '../cache'
import { ProviderHttpError, ProviderJsonParseError, ProviderNetworkError } from './errors'
import { createProvider } from './factory'
import { getProviderConfig, getProviderSecret, type ProviderStores } from './storage'
import {
  missingManualTranslationIds,
  validateManualTranslations,
} from '../../youtube/translation-validation'
import type { ProviderType } from './types'
import type {
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

async function withRetry<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; data: T } | TranslationError> {
  let lastError: unknown

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const data = await fn()
      return { ok: true, data }
    } catch (error) {
      lastError = error

      if (isFatalError(error)) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          fatal: true,
          retried: attempt > 0,
        }
      }

      if (!isRetryableError(error) || attempt >= MAX_RETRIES) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          fatal: false,
          retried: attempt > 0,
        }
      }

      await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)))
    }
  }

  return {
    ok: false,
    error: lastError instanceof Error ? lastError.message : String(lastError),
    fatal: false,
    retried: true,
  }
}

export async function translateSubtitleMessage(
  message: TranslateSubtitleMessage,
  stores: ProviderStores,
): Promise<TranslateSubtitleResult | TranslationError> {
  const providerConfig = await getProviderConfig(stores.sync, message.providerType)
  const cacheKey = createWindowCacheKey(message, providerConfig.model)
  const cached = await getCachedTranslations(stores.local, cacheKey)
  const requestedIds = message.items.map((item) => item.id)

  if (cached && cached.length > 0) {
    return { ok: true, translations: validateManualTranslations(requestedIds, cached) }
  }

  const provider = await resolveProvider(message.providerType, stores)
  const providerItems = message.items.map((item, index) => ({ ...item, id: String(index) }))
  const providerIdToSourceId = new Map(
    providerItems.map((item, index) => [item.id, message.items[index]?.id]),
  )

  const result = await withRetry(() =>
    provider.translateManual({
      items: providerItems,
      targetLanguage: message.targetLanguage,
      contextBefore: message.contextBefore,
      contextAfter: message.contextAfter,
    }),
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

  return {
    ok: true,
    translations,
    usage: result.data.usage,
  }
}

function createWindowCacheKey(message: TranslateSubtitleMessage, model: string): string {
  const first = message.items[0]?.startMs ?? 0
  const windowStartMs = Math.floor(first / 30_000) * 30_000
  const sourceHash = hashString(message.items.map((item) => `${item.id}:${item.text}`).join('\n'))
  return [
    'v1',
    message.videoId,
    message.trackId,
    message.targetLanguage,
    message.providerType,
    model,
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

async function resolveProvider(providerType: ProviderType, stores: ProviderStores) {
  const config = await getProviderConfig(stores.sync, providerType)
  const secret = await getProviderSecret(stores.local, providerType)
  return createProvider(config, secret)
}
