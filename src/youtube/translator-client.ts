import type { CaptionSegment, CaptionTrack } from './caption-types'
import type { ProviderType } from '../background/providers/types'
import type { TranslateSubtitleResult } from '../shared/messages'

import type { TranslationError } from '../shared/messages'

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
    translateSubtitle(input: TranslateSubtitleInput): Promise<TranslateSubtitleResult> {
      return chrome.runtime.sendMessage({
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
      })
    },
  }
}
