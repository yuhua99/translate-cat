import { DEFAULT_SETTINGS, SETTINGS_KEY, type ExtensionSettings } from '../shared/messages'

interface SettingsStorageArea {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export async function getSettings(storage: SettingsStorageArea): Promise<ExtensionSettings> {
  const stored = await storage.get(SETTINGS_KEY)
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(stored[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined),
  }

  return settings
}

export async function setSettings(
  storage: SettingsStorageArea,
  settings: ExtensionSettings,
): Promise<void> {
  await storage.set({ [SETTINGS_KEY]: settings })
}
