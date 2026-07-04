import { describe, expect, test } from 'bun:test'
import { YoutubeSubtitleSession } from '../../src/youtube/session'
import type { TranslatorClient } from '../../src/youtube/translator-client'
import type { ExtensionSettings, TranslateSubtitleResult } from '../../src/shared/messages'

const settings: ExtensionSettings = {
  enabled: true,
  selectionEnabled: true,
  targetLanguage: 'Traditional Chinese',
  providerType: 'openai',
}

function createTranslatorClient(): TranslatorClient & { calls: string[][] } {
  const calls: string[][] = []

  return {
    calls,
    async translateSubtitle(input): Promise<TranslateSubtitleResult> {
      calls.push(input.segments.map((segment) => segment.id))

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

    session.handleCapturedCaptions({
      url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en',
      responseText: JSON.stringify({
        events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'Hello' }] }],
      }),
    })

    await session.ensureTranslations(1000, true)

    expect(session.videoId).toBe('video-1')
    expect(session.mode).toBe('manual')
    expect(client.calls).toEqual([['video-1:en::manual:0']])
    expect(session.translatedCues).toEqual([
      {
        id: 'video-1:en::manual:0',
        startMs: 1000,
        endMs: 2000,
        sourceText: 'Hello',
        translatedText: 'zh:Hello',
        sourceSegmentIds: ['video-1:en::manual:0'],
      },
    ])
  })

  test('does not translate when CC off or already completed', async () => {
    const client = createTranslatorClient()
    const session = new YoutubeSubtitleSession(settings, client)

    session.handleCapturedCaptions({
      url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en',
      responseText: JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: 'Hello' }] }] }),
    })

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

    session.windowFailedHandler = (_windowId, error) => {
      lastError = error
    }

    session.handleCapturedCaptions({
      url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en',
      responseText: JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: 'Hello' }] }] }),
    })

    await expect(session.ensureTranslations(1000, true)).resolves.toBeUndefined()
    expect(lastError).toBe('bad api key')
  })

  test('resetForNavigation clears state and aborts in-flight windows', () => {
    const session = new YoutubeSubtitleSession(settings, createTranslatorClient())

    session.handleCapturedCaptions({
      url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en',
      responseText: JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: 'Hello' }] }] }),
    })
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

  test('recapturing identical captions preserves translation state; changed input resets', async () => {
    const client = createTranslatorClient()
    const session = new YoutubeSubtitleSession(settings, client)

    const captured = {
      url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en',
      responseText: JSON.stringify({
        events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'Hello' }] }],
      }),
    }

    session.handleCapturedCaptions(captured)
    await session.ensureTranslations(1000, true)

    expect(session.windowsCompleted.size).toBeGreaterThan(0)
    const cuesBefore = session.translatedCues
    const completedBefore = new Set(session.windowsCompleted)

    session.handleCapturedCaptions(captured)

    expect(session.translatedCues).toBe(cuesBefore)
    expect(session.windowsCompleted).toEqual(completedBefore)

    session.handleCapturedCaptions({
      url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en',
      responseText: JSON.stringify({
        events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'Changed' }] }],
      }),
    })

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

    session.handleCapturedCaptions({
      url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en',
      responseText: JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: 'Hello' }] }] }),
    })

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
