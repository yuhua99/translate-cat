import type { ProviderConfig, ProviderType } from '../background/providers/types'

export interface ProviderEntry {
  label: string
  defaultModel: string
  models: string[]
}

export const PROVIDER_REGISTRY: Record<ProviderType, ProviderEntry> = {
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-5.4-mini',
    models: [
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.4',
      'gpt-5.5',
      'gpt-5.2',
      'gpt-5.1',
      'gpt-4.1-mini',
      'gpt-4.1',
      'gpt-4o-mini',
    ],
  },
  anthropic: {
    label: 'Anthropic Claude',
    defaultModel: 'claude-haiku-4-5',
    models: [
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'claude-opus-4-1',
    ],
  },
  opencodeZen: {
    label: 'opencode Zen',
    defaultModel: 'deepseek-v4-flash',
    models: [
      'minimax-m2.7',
      'minimax-m2.5',
      'kimi-k2.6',
      'kimi-k2.5',
      'glm-5.1',
      'glm-5',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'qwen3.6-plus',
      'qwen3.5-plus',
      'mimo-v2-pro',
      'mimo-v2-omni',
      'mimo-v2.5-pro',
      'mimo-v2.5',
    ],
  },
  gemini: {
    label: 'Google Gemini',
    defaultModel: 'gemini-3.1-flash-lite',
    models: [
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash',
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
    ],
  },
}

export const ALL_PROVIDER_TYPES = Object.keys(PROVIDER_REGISTRY) as ProviderType[]

export function getProviderLabel(type: ProviderType): string {
  return PROVIDER_REGISTRY[type].label
}

export function getDefaultProviderConfig(type: ProviderType): ProviderConfig {
  return { type, model: PROVIDER_REGISTRY[type].defaultModel }
}

export function getProviderModels(type: ProviderType): string[] {
  return PROVIDER_REGISTRY[type].models
}
