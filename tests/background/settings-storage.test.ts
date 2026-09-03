import { describe, expect, test } from 'bun:test'
import {
  getSettings,
  setAppSettings,
  setSubtitleEnabled,
} from '../../src/background/settings-storage'
import {
  DEFAULT_SETTINGS,
  PROVIDER_KEY,
  SELECTION_ENABLED_KEY,
  SETTINGS_STORAGE_KEYS,
  SUBTITLE_ENABLED_KEY,
  TARGET_LANGUAGE_KEY,
} from '../../src/shared/messages'

function createMemoryStorage(initial: Record<string, unknown> = {}) {
  const data = { ...initial }

  return {
    data,
    async get(keys: string | string[]): Promise<Record<string, unknown>> {
      const requestedKeys = Array.isArray(keys) ? keys : [keys]
      return Object.fromEntries(requestedKeys.map((key) => [key, data[key]]))
    },
    async set(items: Record<string, unknown>): Promise<void> {
      Object.assign(data, items)
    },
  }
}

describe('settings storage', () => {
  test('returns defaults when storage empty', async () => {
    await expect(getSettings(createMemoryStorage())).resolves.toEqual(DEFAULT_SETTINGS)
  })

  test('falls back independently for missing settings keys', async () => {
    const provider = { type: 'opencodeZen' as const, model: 'mimo-v2.5' }
    const stored = {
      [SUBTITLE_ENABLED_KEY]: false,
      [SELECTION_ENABLED_KEY]: false,
      [TARGET_LANGUAGE_KEY]: 'ja',
      [PROVIDER_KEY]: provider,
    }

    for (const missingKey of SETTINGS_STORAGE_KEYS) {
      const partial = { ...stored }
      delete partial[missingKey]

      await expect(getSettings(createMemoryStorage(partial))).resolves.toEqual({
        enabled:
          missingKey === SUBTITLE_ENABLED_KEY
            ? DEFAULT_SETTINGS.enabled
            : stored[SUBTITLE_ENABLED_KEY],
        selectionEnabled:
          missingKey === SELECTION_ENABLED_KEY
            ? DEFAULT_SETTINGS.selectionEnabled
            : stored[SELECTION_ENABLED_KEY],
        targetLanguage:
          missingKey === TARGET_LANGUAGE_KEY
            ? DEFAULT_SETTINGS.targetLanguage
            : stored[TARGET_LANGUAGE_KEY],
        provider: missingKey === PROVIDER_KEY ? DEFAULT_SETTINGS.provider : stored[PROVIDER_KEY],
      })
    }
  })

  test('writes only subtitle enabled', async () => {
    const storage = createMemoryStorage()

    await setSubtitleEnabled(storage, true)

    expect(storage.data).toEqual({ [SUBTITLE_ENABLED_KEY]: true })
  })

  test('writes app settings without subtitle enabled', async () => {
    const storage = createMemoryStorage()
    const provider = { type: 'opencodeZen' as const, model: 'mimo-v2.5' }

    await setAppSettings(storage, {
      selectionEnabled: false,
      targetLanguage: 'ja',
      provider,
    })

    expect(storage.data).toEqual({
      [SELECTION_ENABLED_KEY]: false,
      [TARGET_LANGUAGE_KEY]: 'ja',
      [PROVIDER_KEY]: provider,
    })
  })
})
