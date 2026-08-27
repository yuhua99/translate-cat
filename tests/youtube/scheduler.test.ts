import { describe, expect, test } from 'bun:test'
import { planTranslationWindows, windowFor } from '../../src/youtube/scheduler'

const emptyState = {
  inFlightWindows: new Set<string>(),
  completedWindows: new Set<string>(),
}

describe('windowFor', () => {
  test('returns the containing window at boundaries', () => {
    expect(windowFor(0)).toEqual({ id: '0-30000', startMs: 0, endMs: 30_000 })
    expect(windowFor(29_999)).toEqual({ id: '0-30000', startMs: 0, endMs: 30_000 })
    expect(windowFor(30_000)).toEqual({ id: '30000-60000', startMs: 30_000, endMs: 60_000 })
  })
})

describe('planTranslationWindows', () => {
  test('plans current window and lookahead when buffer low', () => {
    expect(
      planTranslationWindows({
        ...emptyState,
        ccEnabled: true,
        currentTimeMs: 12_000,
      }),
    ).toEqual([
      { id: '0-30000', startMs: 0, endMs: 30_000 },
      { id: '30000-60000', startMs: 30_000, endMs: 60_000 },
    ])
  })

  test('returns nothing when CC off', () => {
    expect(
      planTranslationWindows({
        ...emptyState,
        ccEnabled: false,
        currentTimeMs: 12_000,
      }),
    ).toEqual([])
  })
})
