import { describe, expect, test } from 'bun:test'
import {
  getSettings,
  setSettings,
  type SettingsStorageArea,
} from '../../src/background/settings-storage'
import { DEFAULT_SETTINGS, type ExtensionSettings } from '../../src/shared/messages'

function createMemoryStorage(
  initial: Record<string, unknown> = {},
): SettingsStorageArea & { data: Record<string, unknown> } {
  const data = { ...initial }

  return {
    data,
    async get(key: string): Promise<Record<string, unknown>> {
      return { [key]: data[key] }
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

  test('merges stored partial settings over defaults', async () => {
    const storage = createMemoryStorage({ settings: { enabled: true } })

    await expect(getSettings(storage)).resolves.toEqual({ ...DEFAULT_SETTINGS, enabled: true })
  })

  test('persists full settings object', async () => {
    const storage = createMemoryStorage()
    const settings: ExtensionSettings = {
      enabled: true,
      selectionEnabled: true,
      targetLanguage: 'ja',
      providerType: 'opencodeZen',
    }

    await setSettings(storage, settings)

    expect(storage.data.settings).toEqual(settings)
  })
})
