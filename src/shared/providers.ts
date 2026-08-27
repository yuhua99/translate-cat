import type { ProviderConfig, ProviderType } from '../background/providers/types'

interface ProviderEntry {
  label: string
  defaultModel: string
  models: string[]
}

const PROVIDER_REGISTRY: Record<ProviderType, ProviderEntry> = {
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-5.6-luna',
    models: [
      'gpt-4o-mini',
      'gpt-5-mini',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ],
  },
  codex: {
    label: 'ChatGPT subscription',
    defaultModel: 'gpt-5.6-luna',
    models: ['gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-terra'],
  },
  anthropic: {
    label: 'Anthropic Claude',
    defaultModel: 'claude-haiku-4-5',
    models: [
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-6',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ],
  },
  opencodeZen: {
    label: 'opencode Zen',
    defaultModel: 'mimo-v2.5',
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
      'gpt-5.6-luna',
    ],
  },
  gemini: {
    label: 'Google Gemini',
    defaultModel: 'gemini-3.5-flash-lite',
    models: [
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash-lite',
      'gemini-3.5-flash',
      'gemini-3.7-flash',
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
