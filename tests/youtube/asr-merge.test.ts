import { describe, expect, test } from 'bun:test'
import { mergeAsrSegments } from '../../src/youtube/asr-merge'
import type { CaptionSegment } from '../../src/youtube/caption-types'

function seg(startMs: number, text: string, id?: string): CaptionSegment {
  const stableId = id ?? `s${startMs}`
  return {
    id: stableId,
    startMs,
    text,
  }
}

describe('mergeAsrSegments', () => {
  test('returns empty for empty input', () => {
    expect(mergeAsrSegments([])).toEqual([])
  })

  test('merges segments within gap threshold', () => {
    const merged = mergeAsrSegments([seg(0, 'Hello '), seg(400, 'world')])

    expect(merged).toHaveLength(1)
    expect(merged[0]?.text).toBe('Hello world')
  })

  test('breaks on gap > 700ms', () => {
    const merged = mergeAsrSegments([seg(0, 'First.'), seg(800, 'Second.')])

    expect(merged).toHaveLength(2)
    expect(merged[0]?.text).toBe('First.')
    expect(merged[1]?.text).toBe('Second.')
  })

  test('breaks on accumulated chars > 120', () => {
    const words: CaptionSegment[] = []
    let t = 0
    for (let i = 0; i < 20; i++) {
      words.push(seg(t, 'abcde ')) // 6 chars each
      t += 200
    }

    const merged = mergeAsrSegments(words)
    // 20 * 6 = 120 chars total, but accumulated before adding 20th: 19*6=114, +6=120 not > 120
    // Wait, 20*6 = 120. Need to check: the break is when accumulatedChars + segment.text.length > MAX_CHARS
    // accumulatedChars after 19 items = 114. Adding 20th: 114+6=120. 120 > 120 is false.
    // So all 20 fit in one group. Let me make it 21 items: 120+6=126 > 120 → break.
    expect(merged).toHaveLength(1)
    // join+trim strips trailing space on last segment: 19*"abcde " + "abcde" = 119
    expect(merged[0]?.text).toHaveLength(119)

    const longer: CaptionSegment[] = []
    t = 0
    for (let i = 0; i < 21; i++) {
      longer.push(seg(t, 'abcde '))
      t += 200
    }

    const mergedLong = mergeAsrSegments(longer)
    expect(mergedLong).toHaveLength(2)
  })

  test('breaks on sentence-ending punctuation', () => {
    const merged = mergeAsrSegments([seg(0, 'Hello.'), seg(200, 'World')])

    expect(merged).toHaveLength(2)
    expect(merged[0]?.text).toBe('Hello.')
    expect(merged[1]?.text).toBe('World')
  })

  test('breaks on Chinese punctuation', () => {
    const merged = mergeAsrSegments([seg(0, '你好！'), seg(200, '世界')])

    expect(merged).toHaveLength(2)
  })

  test('breaks on duration > 6s', () => {
    // 12 segments, 600ms apart, spanning 0..6600ms
    const input: CaptionSegment[] = []
    for (let i = 0; i < 12; i++) {
      input.push(seg(i * 600, 'x'))
    }

    const merged = mergeAsrSegments(input)

    // group 1: 0..6000 (11 segments, duration 6000ms, not > 6000)
    // group 2: 6600.. (1 segment, because duration from 0 → 6600 > 6000)
    expect(merged).toHaveLength(2)
    expect(merged[0]?.startMs).toBe(0)
    expect(merged[1]?.startMs).toBe(6600)
  })

  test('uses next group start as cue end', () => {
    const merged = mergeAsrSegments([seg(0, 'First group.'), seg(400, 'Second group.')])

    expect(merged).toHaveLength(2)
    expect(merged[0]?.endMs).toBe(400)
    // no next group for last, endMs computed from last segment start + FALLBACK_END_MS
    expect(merged[1]?.endMs).toBe(400 + 1500)
  })

  test('all rules together: gap, chars, punctuation, duration', () => {
    const input: CaptionSegment[] = [
      seg(0, 'Short.'),
      seg(300, 'Okay'),
      seg(1100, 'Too far gap.'),
      seg(5000, 'Another sentence！'),
      seg(5200, 'Still close'),
    ]

    const merged = mergeAsrSegments(input)

    // Expected groups:
    // [0, "Short."] → punctuation break before "Okay" at 300
    //   Check: "Short." ends with `.` → break. So group 1 = [seg(0)]
    // [300, "Okay"] → gap to next is 800ms > 700 → break. Group 2 = [seg(300)]
    // [1100, "Too far gap."] → ends with `.` → break. Group 3 = [seg(1100)]
    // [5000, "Another sentence！"] → ends with `！` → break. Group 4 = [seg(5000)]
    // [5200, "Still close"] → no next → Group 5 = [seg(5200)]
    expect(merged).toHaveLength(5)
  })
})
