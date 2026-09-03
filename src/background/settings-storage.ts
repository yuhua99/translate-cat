import {
  assembleSettings,
  PROVIDER_KEY,
  SELECTION_ENABLED_KEY,
  SETTINGS_STORAGE_KEYS,
  SUBTITLE_ENABLED_KEY,
  TARGET_LANGUAGE_KEY,
  type ExtensionSettings,
} from '../shared/messages'

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

export async function setAppSettings(
  storage: SettingsStorageArea,
  settings: Pick<ExtensionSettings, 'selectionEnabled' | 'targetLanguage' | 'provider'>,
): Promise<void> {
  await storage.set({
    [SELECTION_ENABLED_KEY]: settings.selectionEnabled,
    [TARGET_LANGUAGE_KEY]: settings.targetLanguage,
    [PROVIDER_KEY]: settings.provider,
  })
}
