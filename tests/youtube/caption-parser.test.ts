import { describe, expect, test } from 'bun:test'
import { parseCapturedCaptions } from '../../src/youtube/caption-parser'

describe('parseCapturedCaptions', () => {
  test('parses JSON3 manual captions with stable ids', () => {
    const result = parseCapturedCaptions({
      url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en&name=English',
      responseText: JSON.stringify({
        events: [
          { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
          { tStartMs: 4000, dDurationMs: 1500, segs: [{ utf8: 'Hello world' }] },
        ],
      }),
    })

    expect(result.track).toMatchObject({ videoId: 'video-1', mode: 'manual' })
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]).toMatchObject({
      id: 'video-1:en:English:manual:0',
      startMs: 1000,
      endMs: 3000,
      text: 'Hello world',
    })
    expect(result.segments[1].id).toBe('video-1:en:English:manual:1')
  })

  test('detects ASR from URL kind param', () => {
    const result = parseCapturedCaptions({
      url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en&kind=asr',
      responseText: JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: 'word' }] }] }),
    })

    expect(result.track.mode).toBe('asr')
    expect(result.track.trackId).toBe('en::asr')
  })

  test('parses SRV-like XML and decodes entities', () => {
    const result = parseCapturedCaptions({
      url: 'https://www.youtube.com/api/timedtext?v=video-2&lang=en',
      responseText:
        '<transcript><text start="1.5" dur="2">Tom &amp; Jerry<br/>Line 2</text></transcript>',
    })

    expect(result.segments).toEqual([
      expect.objectContaining({
        startMs: 1500,
        endMs: 3500,
        text: 'Tom & Jerry\nLine 2',
      }),
    ])
  })

  test('parses TTML paragraphs', () => {
    const result = parseCapturedCaptions({
      url: 'https://www.youtube.com/api/timedtext?v=video-3&lang=ja',
      responseText:
        '<tt><body><div><p begin="00:00:02.500" end="00:00:04.000">こんにちは</p></div></body></tt>',
    })

    expect(result.segments[0]).toMatchObject({ startMs: 2500, endMs: 4000, text: 'こんにちは' })
  })
})
