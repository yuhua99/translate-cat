import { mergeAsrSegments } from './asr-merge'
import { parseCapturedCaptions } from './caption-parser'
import type {
  CaptionMode,
  CaptionSegment,
  CaptionTrack,
  CapturedCaptionResponse,
  TranslatedCue,
} from './caption-types'
import { planTranslationWindows, type TranslationWindow } from './scheduler'
import type { TranslatorClient } from './translator-client'
import type { ExtensionSettings } from '../shared/messages'

export class YoutubeSubtitleSession {
  videoId = ''
  track?: CaptionTrack
  mode?: CaptionMode
  segments: CaptionSegment[] = []
  translatedCues: TranslatedCue[] = []
  windowsInFlight = new Set<string>()
  windowsCompleted = new Set<string>()
  windowsFailed = new Map<string, number>()
  abortController = new AbortController()

  /** Called when a fatal error (401/403) stops the session. */
  fatalErrorHandler?: (error: string) => void
  /** Called when a non-fatal window translation fails after all retries. */
  windowFailedHandler?: (windowId: string, error: string) => void

  constructor(
    private readonly settings: ExtensionSettings,
    private readonly translatorClient: TranslatorClient,
  ) {}

  start(): void {
    this.abortController = new AbortController()
  }

  stop(): void {
    this.abortController.abort()
    this.windowsInFlight.clear()
  }

  resetForNavigation(videoId: string): void {
    this.stop()
    this.videoId = videoId
    this.track = undefined
    this.mode = undefined
    this.segments = []
    this.translatedCues = []
    this.windowsCompleted.clear()
    this.windowsFailed.clear()
    this.start()
  }

  handleCapturedCaptions(input: CapturedCaptionResponse): void {
    const parsed = parseCapturedCaptions(input)

    if (this.videoId && this.videoId !== parsed.track.videoId) {
      this.resetForNavigation(parsed.track.videoId)
    }

    if (
      this.videoId === parsed.track.videoId &&
      this.track?.trackId === parsed.track.trackId &&
      sameSegments(this.segments, parsed.segments)
    ) {
      return
    }

    this.videoId = parsed.track.videoId
    this.track = parsed.track
    this.mode = parsed.track.mode
    this.segments = inferSegmentEndTimes(parsed.segments)
    this.translatedCues = []
    this.windowsInFlight.clear()
    this.windowsCompleted.clear()
    this.windowsFailed.clear()
  }

  async ensureTranslations(currentTimeMs: number, ccEnabled: boolean): Promise<void> {
    if (!this.settings.enabled || !this.track) {
      return
    }

    const windows = planTranslationWindows({
      inFlightWindows: this.windowsInFlight,
      completedWindows: this.windowsCompleted,
      ccEnabled,
      currentTimeMs,
    })

    await Promise.all(windows.map((window) => this.translateWindow(window)))
  }

  private async translateWindow(window: TranslationWindow): Promise<void> {
    if (!this.track) {
      return
    }

    const failedAt = this.windowsFailed.get(window.id)
    if (failedAt !== undefined) {
      if (Date.now() - failedAt < RETRY_COOLDOWN_MS) {
        return
      }
      this.windowsFailed.delete(window.id)
    }

    const segments = this.segmentsInWindow(window)

    if (segments.length === 0) {
      this.windowsCompleted.add(window.id)
      return
    }

    this.windowsInFlight.add(window.id)

    try {
      const contextBefore = this.getContextCues(window, 'before', 2)
      const contextAfter = this.getContextCues(window, 'after', 2)
      if (this.mode === 'asr') {
        await this.translateManualSegments(
          mergeAsrSegments(segments),
          true,
          contextBefore,
          contextAfter,
        )
      } else {
        await this.translateManualSegments(segments, false, contextBefore, contextAfter)
      }

      this.windowsCompleted.add(window.id)
    } catch (error) {
      if (this.abortController.signal.aborted) return

      const message = error instanceof Error ? error.message : String(error)
      const fatal = (error as { fatal?: boolean }).fatal === true

      if (fatal) {
        this.windowsFailed.set(window.id, Infinity)
        this.fatalErrorHandler?.(message)
        return
      }

      this.windowsFailed.set(window.id, Date.now())
      this.windowFailedHandler?.(window.id, message)
    } finally {
      this.windowsInFlight.delete(window.id)
    }
  }

  private getContextCues(
    window: TranslationWindow,
    side: 'before' | 'after',
    maxCount: number,
  ): Array<{ id: string; text: string }> {
    if (side === 'before') {
      const before = this.segments.filter((s) => s.startMs < window.startMs)
      return before.slice(-maxCount).map((s) => ({ id: s.id, text: s.text }))
    }

    const after = this.segments.filter((s) => s.startMs >= window.endMs)
    return after.slice(0, maxCount).map((s) => ({ id: s.id, text: s.text }))
  }

  private async translateManualSegments(
    segments: CaptionSegment[],
    extendForReading: boolean,
    contextBefore?: Array<{ id: string; text: string }>,
    contextAfter?: Array<{ id: string; text: string }>,
  ): Promise<void> {
    if (!this.track) {
      return
    }

    const result = await this.translatorClient.translateSubtitle(
      {
        providerType: this.settings.providerType,
        videoId: this.videoId,
        track: this.track,
        segments,
        targetLanguage: this.settings.targetLanguage,
        contextBefore,
        contextAfter,
      },
      this.abortController.signal,
    )

    if (!result.ok) {
      const error = new Error(result.error) as Error & { fatal?: boolean }
      error.fatal = result.fatal
      throw error
    }

    const translations = new Map(result.translations.map((item) => [item.id, item.text]))

    for (const segment of segments) {
      const translatedText = translations.get(segment.id)

      if (!translatedText) {
        continue
      }

      this.upsertTranslatedCue({
        id: segment.id,
        startMs: segment.startMs,
        endMs: extendForReading
          ? adjustCueEndMs(
              segment.startMs,
              segment.endMs ?? segment.startMs + 1_500,
              translatedText,
            )
          : (segment.endMs ?? segment.startMs + 1_500),
        sourceText: segment.text,
        translatedText,
        sourceSegmentIds: [segment.id],
      })
    }
  }

  private upsertTranslatedCue(cue: TranslatedCue): void {
    const existingIndex = this.translatedCues.findIndex((item) => item.id === cue.id)
    if (existingIndex >= 0) {
      this.translatedCues[existingIndex] = cue
    } else {
      this.translatedCues.push(cue)
    }

    this.translatedCues.sort((left, right) => left.startMs - right.startMs)
  }

  private segmentsInWindow(window: TranslationWindow): CaptionSegment[] {
    return this.segments.filter(
      (segment) => segment.startMs >= window.startMs && segment.startMs < window.endMs,
    )
  }
}

const RETRY_COOLDOWN_MS = 30_000
const READ_MS_PER_CHAR = 200
const MIN_READ_MS = 800
const FALLBACK_SEGMENT_MS = 1_500

function inferSegmentEndTimes(segments: readonly CaptionSegment[]): CaptionSegment[] {
  return segments.map((segment, index) => {
    if (segment.endMs !== undefined) return segment

    const next = segments[index + 1]
    return {
      ...segment,
      endMs: next ? Math.max(segment.startMs, next.startMs) : segment.startMs + FALLBACK_SEGMENT_MS,
    }
  })
}

function adjustCueEndMs(startMs: number, endMs: number, text: string): number {
  const readMs = Math.max(MIN_READ_MS, Array.from(text).length * READ_MS_PER_CHAR)
  return Math.max(endMs, startMs + readMs)
}

function sameSegments(a: readonly CaptionSegment[], b: readonly CaptionSegment[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].startMs !== b[i].startMs || a[i].text !== b[i].text) return false
  }
  return true
}
