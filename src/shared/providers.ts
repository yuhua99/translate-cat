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
    models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5-mini', 'gpt-4o-mini'],
  },
  anthropic: {
    label: 'Anthropic Claude',
    defaultModel: 'claude-haiku-4-5',
    models: [
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ],
  },
  opencodeZen: {
    label: 'opencode Zen',
    defaultModel: 'deepseek-v4-flash',
    models: [
      'glm-5.2',
      'minimax-m3',
      'minimax-m2.7',
      'kimi-k2.7',
      'qwen3.7-max',
      'qwen3.7-plus',
      'mimo-v2.5-pro',
      'mimo-v2.5',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
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
