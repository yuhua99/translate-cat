import type { CodexTokens } from '../../shared/codex-oauth'
import type { ManualTranslationItem } from '../../youtube/translation-validation'
import type { ContextCue } from '../../shared/messages'

export type ProviderType = 'openai' | 'anthropic' | 'opencodeZen' | 'gemini' | 'codex'

export interface ProviderConfig {
  type: ProviderType
  model: string
}

export interface ProviderSecret {
  apiKey?: string
  codexAuth?: CodexTokens
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

export interface SelectionTranslateInput {
  text: string
  targetLanguage: string
}

export interface SelectionStreamOptions {
  signal?: AbortSignal
  onDelta: (text: string) => void
}

export interface ProviderTestOutput {
  ok: true
}

export interface AiProvider {
  translateManual(input: ManualTranslateInput, signal?: AbortSignal): Promise<ManualTranslateOutput>
  translateSelection?(
    input: SelectionTranslateInput,
    options: SelectionStreamOptions,
  ): Promise<void>
  testConnection(): Promise<ProviderTestOutput>
}
