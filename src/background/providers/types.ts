import type { ManualTranslationItem } from '../../youtube/translation-validation'
import type { ContextCue } from '../../shared/messages'

export type ProviderType = 'openai' | 'anthropic' | 'opencodeZen' | 'gemini'

export interface ProviderConfig {
  type: ProviderType
  model: string
}

export interface ProviderSecret {
  apiKey?: string
}

export interface ManualTranslateInput {
  mode?: 'subtitle' | 'selection' | 'dictionary'
  items: Array<{
    id: string
    text: string
    startMs: number
    endMs?: number
  }>
  targetLanguage: string
  contextBefore?: ContextCue[]
  contextAfter?: ContextCue[]
}

export interface ManualTranslateOutput {
  translations: ManualTranslationItem[]
}

export interface ProviderTestOutput {
  ok: true
  text: string
}

export interface AiProvider {
  translateManual(input: ManualTranslateInput, signal?: AbortSignal): Promise<ManualTranslateOutput>
  testConnection(): Promise<ProviderTestOutput>
}
