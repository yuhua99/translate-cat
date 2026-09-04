import type { ManualTranslationItem } from '../../youtube/translation-validation'
import type { ContextCue, ProviderTestOutput } from '../../shared/provider-types'

export type {
  ProviderType,
  ProviderConfig,
  ProviderSecret,
  ProviderTestOutput,
} from '../../shared/provider-types'

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
}

export interface ProviderRequestContext {
  sessionId?: string
}

export interface SelectionTranslateInput {
  text: string
  targetLanguage: string
}

export interface SelectionStreamOptions {
  signal?: AbortSignal
  onDelta: (text: string) => void
}

export interface AiProvider {
  translateManual(input: ManualTranslateInput, signal?: AbortSignal): Promise<ManualTranslateOutput>
  translateSelection(input: SelectionTranslateInput, options: SelectionStreamOptions): Promise<void>
  testConnection(): Promise<ProviderTestOutput>
}
