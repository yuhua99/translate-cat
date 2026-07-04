import type { ManualTranslationItem } from '../../youtube/translation-validation'
import type { ContextCue, ProviderUsage } from '../../shared/messages'

export type ProviderType = 'openai' | 'anthropic' | 'opencodeZen' | 'gemini'

export interface ProviderConfig {
  type: ProviderType
  model: string
}

export interface ProviderSecret {
  apiKey?: string
}

export interface ManualTranslateInput {
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
  usage?: ProviderUsage
}

export interface ProviderTestOutput {
  ok: true
  text: string
  usage?: ProviderUsage
}

export interface AiProvider {
  translateManual(input: ManualTranslateInput, signal?: AbortSignal): Promise<ManualTranslateOutput>
  testConnection(): Promise<ProviderTestOutput>
}
