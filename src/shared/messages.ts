import type {
  ContextCue,
  ProviderConfig,
  ProviderSecret,
  ProviderTestOutput,
  ProviderType,
} from './provider-types'
import { getDefaultModel } from './providers'
import type { ManualTranslationItem } from '../youtube/translation-validation'

export const SUBTITLE_ENABLED_KEY = 'subtitleEnabled'
export const SELECTION_ENABLED_KEY = 'selectionEnabled'
export const TARGET_LANGUAGE_KEY = 'targetLanguage'
export const PROVIDER_KEY = 'provider'
export const SETTINGS_STORAGE_KEYS = [
  SUBTITLE_ENABLED_KEY,
  SELECTION_ENABLED_KEY,
  TARGET_LANGUAGE_KEY,
  PROVIDER_KEY,
]
export const PROVIDER_SECRETS_KEY = 'providerSecrets'
export const SELECTION_TRANSLATION_PORT = 'translate-cat-selection-translation'

export interface ExtensionSettings {
  enabled: boolean
  selectionEnabled: boolean
  targetLanguage: string
  provider: ProviderConfig
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: false,
  selectionEnabled: true,
  targetLanguage: 'zh-TW',
  provider: { type: 'codex', model: getDefaultModel('codex') },
}

export function assembleSettings(stored: Record<string, unknown>): ExtensionSettings {
  return {
    enabled: (stored[SUBTITLE_ENABLED_KEY] ?? DEFAULT_SETTINGS.enabled) as boolean,
    selectionEnabled: (stored[SELECTION_ENABLED_KEY] ??
      DEFAULT_SETTINGS.selectionEnabled) as boolean,
    targetLanguage: (stored[TARGET_LANGUAGE_KEY] ?? DEFAULT_SETTINGS.targetLanguage) as string,
    provider: (stored[PROVIDER_KEY] ?? DEFAULT_SETTINGS.provider) as ProviderConfig,
  }
}

export interface SelectionTranslationRequest {
  type: 'translate'
  requestId: string
  text: string
  targetLanguage: string
}

export type SelectionTranslationEvent =
  | { type: 'started'; requestId: string }
  | { type: 'delta'; requestId: string; text: string }
  | { type: 'reset'; requestId: string }
  | { type: 'complete'; requestId: string }
  | { type: 'error'; requestId: string; error: string }

export interface TranslateSubtitleMessage {
  type: 'TRANSLATE_SUBTITLE_AI_PROVIDER'
  provider: ProviderConfig
  videoId: string
  trackId: string
  items: Array<{
    id: string
    text: string
    startMs: number
    endMs?: number
  }>
  targetLanguage: string
  contextBefore?: ContextCue[]
  contextAfter?: ContextCue[]
  requestId?: string
}

export interface TranslateSubtitleResult {
  ok: true
  translations: ManualTranslationItem[]
}

export type ExtensionMessage =
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_SUBTITLE_ENABLED'; enabled: boolean }
  | {
      type: 'SET_APP_SETTINGS'
      selectionEnabled: boolean
      targetLanguage: string
      provider: ProviderConfig
    }
  | { type: 'SET_PROVIDER_SECRET'; providerType: ProviderType; secret: ProviderSecret }
  | { type: 'GET_PROVIDER_AUTH_STATUS'; providerType: ProviderType }
  | { type: 'TEST_PROVIDER'; config: ProviderConfig; secret: ProviderSecret }
  | { type: 'VALIDATE_ACTIVE_PROVIDER' }
  | { type: 'CONTEXT_MENU_TRANSLATE' }
  | { type: 'CANCEL_TRANSLATION'; requestId: string }
  | TranslateSubtitleMessage

export type SettingsResponse =
  | { ok: true; settings: ExtensionSettings }
  | { ok: false; error: string }
export type MessageResponse = { ok: true } | { ok: false; error: string }
export type ProviderTestResponse = ProviderTestOutput | { ok: false; error: string }
export type ProviderAuthStatusResponse =
  | { ok: true; signedIn: boolean }
  | { ok: false; error: string }
export interface TranslationError {
  ok: false
  error: string
  fatal?: boolean
}

type TranslationResponse = TranslateSubtitleResult | TranslationError
export type ExtensionResponse =
  | SettingsResponse
  | MessageResponse
  | ProviderTestResponse
  | ProviderAuthStatusResponse
  | TranslationResponse

export function watchProviderSecretChanges(callback: () => void): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[PROVIDER_SECRETS_KEY]) {
      callback()
    }
  })
}

export function watchSettings(callback: (settings: ExtensionSettings) => void): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !SETTINGS_STORAGE_KEYS.some((key) => changes[key])) return
    void chrome.storage.sync
      .get(SETTINGS_STORAGE_KEYS)
      .then((stored) => callback(assembleSettings(stored)))
      .catch(() => undefined)
  })
}
