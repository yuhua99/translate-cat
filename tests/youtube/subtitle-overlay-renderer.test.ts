import { describe, expect, test } from 'bun:test'
import { findActiveCue } from '../../src/youtube/subtitle-overlay-renderer'
import type { TranslatedCue } from '../../src/youtube/caption-types'

function cue(id: string, startMs: number, endMs: number): TranslatedCue {
  return { id, startMs, endMs, translatedText: id }
}

describe('findActiveCue', () => {
  test('clamps cue end at next cue start', () => {
    const cues = [cue('a', 0, 3000), cue('b', 2000, 4000)]

    expect(findActiveCue(cues, 1999)?.id).toBe('a')
    expect(findActiveCue(cues, 2000)?.id).toBe('b')
  })
})
