import type { CaptionSegment, CaptionTrack } from './caption-types'
import type { ProviderType } from '../background/providers/types'
import type { TranslateSubtitleResult, TranslationError } from '../shared/messages'

export interface TranslatorClient {
  translateSubtitle(
    input: TranslateSubtitleInput,
    signal: AbortSignal,
  ): Promise<TranslateSubtitleResult | TranslationError>
}

export interface TranslateSubtitleInput {
  providerType: ProviderType
  videoId: string
  track: CaptionTrack
  segments: CaptionSegment[]
  targetLanguage: string
  contextBefore?: Array<{ id: string; text: string }>
  contextAfter?: Array<{ id: string; text: string }>
}

export function createRuntimeTranslatorClient(): TranslatorClient {
  return {
    async translateSubtitle(
      input: TranslateSubtitleInput,
      signal?: AbortSignal,
    ): Promise<TranslateSubtitleResult | TranslationError> {
      if (signal?.aborted) {
        return { ok: false, error: 'aborted', fatal: false }
      }

      const requestId = crypto.randomUUID()

      const onAbort = (): void => {
        try {
          void chrome.runtime.sendMessage({ type: 'CANCEL_TRANSLATION', requestId }).catch(() => {})
        } catch {}
      }

      signal?.addEventListener('abort', onAbort, { once: true })

      try {
        return await chrome.runtime.sendMessage({
          type: 'TRANSLATE_SUBTITLE_AI_PROVIDER',
          providerType: input.providerType,
          videoId: input.videoId,
          trackId: input.track.trackId,
          targetLanguage: input.targetLanguage,
          items: input.segments.map((segment) => ({
            id: segment.id,
            text: segment.text,
            startMs: segment.startMs,
            endMs: segment.endMs,
          })),
          contextBefore: input.contextBefore,
          contextAfter: input.contextAfter,
          requestId,
        })
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}
