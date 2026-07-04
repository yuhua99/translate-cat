import { describe, expect, test } from 'bun:test'
import { planTranslationWindows } from '../../src/youtube/scheduler'

const emptyState = {
  inFlightWindows: new Set<string>(),
  completedWindows: new Set<string>(),
}

describe('planTranslationWindows', () => {
  test('plans current window and lookahead when buffer low', () => {
    expect(
      planTranslationWindows({
        ...emptyState,
        ccEnabled: true,
        currentTimeMs: 12_000,
        translatedUpToMs: 15_000,
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
        translatedUpToMs: 0,
      }),
    ).toEqual([])
  })
})
