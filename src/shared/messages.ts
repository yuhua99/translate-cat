import type {
  ProviderConfig,
  ProviderSecret,
  ProviderTestOutput,
  ProviderType,
} from '../background/providers/types'
import type { ManualTranslationItem } from '../youtube/translation-validation'

export const SETTINGS_KEY = 'settings'

export interface ExtensionSettings {
  enabled: boolean
  selectionEnabled: boolean
  targetLanguage: string
  providerType: ProviderType
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: false,
  selectionEnabled: true,
  targetLanguage: 'zh-TW',
  providerType: 'opencodeZen',
}

export interface ProviderUsage {
  inputTokens?: number
  outputTokens?: number
}

export interface ContextCue {
  id: string
  text: string
}

export interface TranslateSubtitleMessage {
  type: 'TRANSLATE_SUBTITLE_AI_PROVIDER'
  providerType: ProviderType
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
  usage?: ProviderUsage
}

export type ExtensionMessage =
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_SETTINGS'; settings: ExtensionSettings }
  | { type: 'PING' }
  | { type: 'GET_PROVIDER_CONFIG'; providerType: ProviderType }
  | { type: 'SET_PROVIDER_CONFIG'; config: ProviderConfig }
  | { type: 'SET_PROVIDER_SECRET'; providerType: ProviderType; secret: ProviderSecret }
  | { type: 'TEST_PROVIDER'; config: ProviderConfig; secret: ProviderSecret }
  | { type: 'VALIDATE_ACTIVE_PROVIDER' }
  | { type: 'TRANSLATE_TEXT'; text: string }
  | { type: 'CANCEL_TRANSLATION'; requestId: string }
  | TranslateSubtitleMessage

export type SettingsResponse =
  | { ok: true; settings: ExtensionSettings }
  | { ok: false; error: string }
export type MessageResponse = { ok: true; message: string } | { ok: false; error: string }
export type ProviderConfigResponse =
  | { ok: true; config: ProviderConfig }
  | { ok: false; error: string }
export type ProviderTestResponse = ProviderTestOutput | { ok: false; error: string }
export interface TranslationError {
  ok: false
  error: string
  fatal?: boolean
  retried?: boolean
}

export type TranslationResponse = TranslateSubtitleResult | TranslationError
export type TranslateTextResponse =
  | { ok: true; translation: string; usage?: ProviderUsage }
  | TranslationError
export type ExtensionResponse =
  | SettingsResponse
  | MessageResponse
  | ProviderConfigResponse
  | ProviderTestResponse
  | TranslationResponse
  | TranslateTextResponse

export function watchSettings(callback: (settings: ExtensionSettings) => void): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return
    const change = changes[SETTINGS_KEY]
    if (!change) return
    const next = change.newValue
    const merged: ExtensionSettings =
      next && typeof next === 'object'
        ? { ...DEFAULT_SETTINGS, ...(next as Partial<ExtensionSettings>) }
        : { ...DEFAULT_SETTINGS }
    callback(merged)
  })
}
