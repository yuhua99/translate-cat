import {
  assembleSettings,
  DARK_MODE_KEY,
  PROVIDER_KEY,
  SELECTION_ENABLED_KEY,
  SETTINGS_STORAGE_KEYS,
  SUBTITLE_ENABLED_KEY,
  TARGET_LANGUAGE_KEY,
  type ExtensionSettings,
} from '../shared/messages'
import type { ProviderConfig } from '../shared/provider-types'

interface SettingsStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export async function getSettings(storage: SettingsStorageArea): Promise<ExtensionSettings> {
  const stored = await storage.get(SETTINGS_STORAGE_KEYS)
  return assembleSettings(stored)
}

export async function setSubtitleEnabled(
  storage: SettingsStorageArea,
  enabled: boolean,
): Promise<void> {
  await storage.set({ [SUBTITLE_ENABLED_KEY]: enabled })
}

export async function setPreferences(
  storage: SettingsStorageArea,
  preferences: Pick<ExtensionSettings, 'selectionEnabled' | 'targetLanguage' | 'darkMode'>,
): Promise<void> {
  await storage.set({
    [SELECTION_ENABLED_KEY]: preferences.selectionEnabled,
    [TARGET_LANGUAGE_KEY]: preferences.targetLanguage,
    [DARK_MODE_KEY]: preferences.darkMode,
  })
}

export async function setProviderConfig(
  storage: SettingsStorageArea,
  config: ProviderConfig,
): Promise<void> {
  await storage.set({ [PROVIDER_KEY]: config })
}
