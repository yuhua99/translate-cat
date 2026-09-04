import { describe, expect, test } from 'bun:test'
import { YoutubeSubtitleSession } from '../../src/youtube/session'
import type { TranslatorClient } from '../../src/youtube/translator-client'
import type { ExtensionSettings, TranslateSubtitleResult } from '../../src/shared/messages'

const settings: ExtensionSettings = {
  enabled: true,
  selectionEnabled: true,
  targetLanguage: 'Traditional Chinese',
  provider: { type: 'openai', model: 'gpt-4o-mini' },
}

function createTranslatorClient(): TranslatorClient & { calls: string[][]; texts: string[][] } {
  const calls: string[][] = []
  const texts: string[][] = []

  return {
    calls,
    texts,
    async translateSubtitle(input): Promise<TranslateSubtitleResult> {
      calls.push(input.segments.map((segment) => segment.id))
      texts.push(input.segments.map((segment) => segment.text))

      return {
        ok: true,
        translations: input.segments.map((segment) => ({
          id: segment.id,
          text: `zh:${segment.text}`,
        })),
      }
    },
  }
}

describe('YoutubeSubtitleSession', () => {
  test('parses captured manual captions and translates current window', async () => {
    const client = createTranslatorClient()
    const session = new YoutubeSubtitleSession(settings, client)

    expect(
      session.handleCapturedCaptions(
        {
          url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en',
          responseText: JSON.stringify({
            events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'Hello' }] }],
          }),
        },
        'video-1',
      ),
    ).toBe(true)

    await session.ensureTranslations(1000, true)

    expect(session.videoId).toBe('video-1')
    expect(session.track?.mode).toBe('manual')
    expect(client.calls).toEqual([['video-1:en::manual:0']])
    expect(session.translatedCues).toEqual([
      {
        id: 'video-1:en::manual:0',
        startMs: 1000,
        endMs: 2000,
        translatedText: 'zh:Hello',
      },
    ])
  })

  test('merges ASR captions using the captured language code', async () => {
    const client = createTranslatorClient()
    const session = new YoutubeSubtitleSession(settings, client)

    session.handleCapturedCaptions(
      {
        url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=fr&kind=asr',
        responseText: JSON.stringify({
          events: [
            { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'café' }] },
            { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'latte' }] },
          ],
        }),
      },
      'video-1',
    )

    await session.ensureTranslations(1000, true)

    expect(client.texts).toEqual([['café latte']])
  })

  test('returns pending segments only for in-flight windows', () => {
    const session = new YoutubeSubtitleSession(settings, createTranslatorClient())

    session.handleCapturedCaptions(
      {
        url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en',
        responseText: JSON.stringify({
          events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'Hello' }] }],
        }),
      },
      'video-1',
    )

    session.windowsInFlight.add('0-30000')
    expect(session.pendingSegmentAt(1500)?.text).toBe('Hello')

    session.windowsCompleted.add('0-30000')
    expect(session.pendingSegmentAt(1500)).toBeUndefined()

    session.windowsCompleted.clear()
    session.windowsFailed.set('0-30000', Date.now())
    expect(session.pendingSegmentAt(1500)).toBeUndefined()

    session.windowsFailed.clear()
    session.windowsInFlight.clear()
    expect(session.pendingSegmentAt(1500)).toBeUndefined()

    session.windowsInFlight.add('0-30000')
    expect(session.pendingSegmentAt(2500)).toBeUndefined()
  })

  test('does not translate when CC off or already completed', async () => {
    const client = createTranslatorClient()
    const session = new YoutubeSubtitleSession(settings, client)

    session.handleCapturedCaptions(
      {
        url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en',
        responseText: JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: 'Hello' }] }] }),
      },
      'video-1',
    )

    await session.ensureTranslations(1000, false)
    expect(client.calls).toEqual([])

    await session.ensureTranslations(1000, true)
    await session.ensureTranslations(1000, true)
    expect(client.calls).toHaveLength(1)
  })

  test('reports translation errors via onWindowFailed callback', async () => {
    let lastError = ''

    const session = new YoutubeSubtitleSession(settings, {
      async translateSubtitle() {
        throw new Error('bad api key')
      },
    })

    session.windowFailedHandler = (error) => {
      lastError = error
    }

    session.handleCapturedCaptions(
      {
        url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en',
        responseText: JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: 'Hello' }] }] }),
      },
      'video-1',
    )

    await expect(session.ensureTranslations(1000, true)).resolves.toBeUndefined()
    expect(lastError).toBe('bad api key')
  })

  test('resetForNavigation clears state and aborts in-flight windows', () => {
    const session = new YoutubeSubtitleSession(settings, createTranslatorClient())

    session.handleCapturedCaptions(
      {
        url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en',
        responseText: JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: 'Hello' }] }] }),
      },
      'video-1',
    )
    session.windowsInFlight.add('0-30000')
    session.windowsCompleted.add('0-30000')
    session.windowsFailed.set('0-30000', Date.now())

    session.resetForNavigation('video-2')

    expect(session.videoId).toBe('video-2')
    expect(session.segments).toEqual([])
    expect(session.translatedCues).toEqual([])
    expect(session.windowsInFlight.size).toBe(0)
    expect(session.windowsCompleted.size).toBe(0)
    expect(session.windowsFailed.size).toBe(0)
  })

  test('rejects a stale capture without changing the active video session', async () => {
    const client = createTranslatorClient()
    const session = new YoutubeSubtitleSession(settings, client)

    expect(
      session.handleCapturedCaptions(
        {
          url: 'https://www.youtube.com/api/timedtext?v=video-b&lang=en',
          responseText: JSON.stringify({
            events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'B caption' }] }],
          }),
        },
        'video-b',
      ),
    ).toBe(true)
    await session.ensureTranslations(1000, true)
    expect(session.translatedCues).toHaveLength(1)
    expect(session.windowsCompleted.size).toBeGreaterThan(0)

    const signalBefore = session.abortController.signal
    const trackBefore = { ...session.track }
    const segmentsBefore = [...session.segments]
    const translatedCuesBefore = [...session.translatedCues]
    const completedBefore = new Set(session.windowsCompleted)
    const callsBefore = [...client.calls]

    const staleCapture = {
      url: 'https://www.youtube.com/api/timedtext?v=video-a&lang=en',
      responseText: JSON.stringify({
        events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'A caption' }] }],
      }),
    }

    expect(session.handleCapturedCaptions(staleCapture, 'video-b')).toBe(false)
    expect(session.handleCapturedCaptions(staleCapture, '')).toBe(false)

    expect(session.videoId).toBe('video-b')
    expect(session.track).toEqual(trackBefore)
    expect(session.segments).toEqual(segmentsBefore)
    expect(session.translatedCues).toEqual(translatedCuesBefore)
    expect(session.windowsCompleted).toEqual(completedBefore)
    expect(session.abortController.signal).toBe(signalBefore)
    expect(signalBefore.aborted).toBe(false)
    expect(client.calls).toEqual(callsBefore)
  })

  test('recapturing identical captions preserves translation state; changed input resets', async () => {
    const client = createTranslatorClient()
    const session = new YoutubeSubtitleSession(settings, client)

    const captured = {
      url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en',
      responseText: JSON.stringify({
        events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'Hello' }] }],
      }),
    }

    session.handleCapturedCaptions(captured, 'video-1')
    await session.ensureTranslations(1000, true)

    expect(session.windowsCompleted.size).toBeGreaterThan(0)
    const cuesBefore = session.translatedCues
    const completedBefore = new Set(session.windowsCompleted)

    expect(session.handleCapturedCaptions(captured, 'video-1')).toBe(true)

    expect(session.translatedCues).toBe(cuesBefore)
    expect(session.windowsCompleted).toEqual(completedBefore)

    session.handleCapturedCaptions(
      {
        url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en',
        responseText: JSON.stringify({
          events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'Changed' }] }],
        }),
      },
      'video-1',
    )

    expect(session.translatedCues).toEqual([])
    expect(session.windowsCompleted.size).toBe(0)
  })

  test('retries a non-fatally failed window after cooldown', async () => {
    let attempts = 0
    const session = new YoutubeSubtitleSession(settings, {
      async translateSubtitle(input) {
        attempts += 1
        if (attempts === 1) {
          throw new Error('transient')
        }
        return {
          ok: true,
          translations: input.segments.map((segment) => ({
            id: segment.id,
            text: `zh:${segment.text}`,
          })),
        }
      },
    })

    session.handleCapturedCaptions(
      {
        url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en',
        responseText: JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: 'Hello' }] }] }),
      },
      'video-1',
    )

    await session.ensureTranslations(1000, true)
    expect(attempts).toBe(1)
    expect(session.windowsFailed.size).toBe(1)

    await session.ensureTranslations(1000, true)
    expect(attempts).toBe(1)

    for (const key of session.windowsFailed.keys()) {
      session.windowsFailed.set(key, Date.now() - 31_000)
    }

    const failedId = [...session.windowsFailed.keys()][0]

    await session.ensureTranslations(1000, true)
    expect(attempts).toBe(2)
    expect(session.windowsFailed.has(failedId)).toBe(false)
    expect(session.windowsCompleted.has(failedId)).toBe(true)
  })
})
