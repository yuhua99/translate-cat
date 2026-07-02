import { describe, expect, test } from 'bun:test'
import {
  missingManualTranslationIds,
  validateManualTranslations,
} from '../../src/youtube/translation-validation'

describe('validateManualTranslations', () => {
  test('keeps requested ids, ignores unknown ids and duplicates', () => {
    const valid = validateManualTranslations(
      ['a', 'b'],
      [
        { id: 'a', text: 'A' },
        { id: 'x', text: 'X' },
        { id: 'a', text: 'A duplicate' },
        { id: 'b', text: 'B' },
      ],
    )

    expect(valid).toEqual([
      { id: 'a', text: 'A' },
      { id: 'b', text: 'B' },
    ])
  })

  test('rejects items with non-string text', () => {
    const raw = [
      { id: 'a', text: 'ok' },
      { id: 'b', text: 123 },
    ] as unknown as Array<{ id: string; text: string }>

    const valid = validateManualTranslations(['a', 'b'], raw)

    expect(valid).toEqual([{ id: 'a', text: 'ok' }])
  })

  test('reports missing requested ids', () => {
    expect(missingManualTranslationIds(['a', 'b', 'c'], [{ id: 'a', text: 'A' }])).toEqual([
      'b',
      'c',
    ])
  })
})
