import { describe, expect, test } from 'bun:test'
import { parseYouTubeVideoId } from '../../src/youtube/video-load'

describe('parseYouTubeVideoId', () => {
  test('parses a watch page video id', () => {
    expect(parseYouTubeVideoId(new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))).toBe(
      'dQw4w9WgXcQ',
    )
  })

  test('returns null for a watch page without v', () => {
    expect(parseYouTubeVideoId(new URL('https://www.youtube.com/watch'))).toBeNull()
  })

  test('returns null for an empty watch page video id', () => {
    expect(parseYouTubeVideoId(new URL('https://www.youtube.com/watch?v='))).toBeNull()
  })

  test('parses a live page video id', () => {
    expect(parseYouTubeVideoId(new URL('https://www.youtube.com/live/dQw4w9WgXcQ'))).toBe(
      'dQw4w9WgXcQ',
    )
  })

  test('parses a live page video id with a trailing slash', () => {
    expect(parseYouTubeVideoId(new URL('https://www.youtube.com/live/dQw4w9WgXcQ/'))).toBe(
      'dQw4w9WgXcQ',
    )
  })

  test('returns null for a live page without a video id', () => {
    expect(parseYouTubeVideoId(new URL('https://www.youtube.com/live/'))).toBeNull()
  })

  test('returns null for a channel live page', () => {
    expect(parseYouTubeVideoId(new URL('https://www.youtube.com/@channel/live'))).toBeNull()
  })
})
