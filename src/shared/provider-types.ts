import type { CodexTokens } from './codex-oauth'

export type ProviderType = 'openai' | 'anthropic' | 'opencodeZen' | 'gemini' | 'codex'

export interface ProviderConfig {
  type: ProviderType
  model: string
}

export interface ProviderSecret {
  apiKey?: string
  codexAuth?: CodexTokens
}

export interface ProviderTestOutput {
  ok: true
}

export interface ContextCue {
  id: string
  text: string
}
