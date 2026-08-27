import type { ProviderConfig, ProviderType } from '../background/providers/types'

interface ModelPreset {
  id: string
  disableThinking?: true
}

interface ProviderEntry {
  label: string
  defaultModel: string
  models: ModelPreset[]
}

const PROVIDER_REGISTRY: Record<ProviderType, ProviderEntry> = {
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-5.6-luna',
    models: [
      { id: 'gpt-4o-mini' },
      { id: 'gpt-5-mini' },
      { id: 'gpt-5.4-mini', disableThinking: true },
      { id: 'gpt-5.4-nano', disableThinking: true },
      { id: 'gpt-5.6-terra', disableThinking: true },
      { id: 'gpt-5.6-luna', disableThinking: true },
    ],
  },
  codex: {
    label: 'ChatGPT subscription',
    defaultModel: 'gpt-5.6-luna',
    models: [
      { id: 'gpt-5.4-mini', disableThinking: true },
      { id: 'gpt-5.5', disableThinking: true },
      { id: 'gpt-5.6-luna', disableThinking: true },
      { id: 'gpt-5.6-terra', disableThinking: true },
    ],
  },
  anthropic: {
    label: 'Anthropic Claude',
    defaultModel: 'claude-haiku-4-5',
    models: [
      { id: 'claude-opus-5', disableThinking: true },
      { id: 'claude-opus-4-8', disableThinking: true },
      { id: 'claude-opus-4-6', disableThinking: true },
      { id: 'claude-sonnet-5', disableThinking: true },
      { id: 'claude-sonnet-4-6', disableThinking: true },
      { id: 'claude-haiku-4-5', disableThinking: true },
    ],
  },
  opencodeZen: {
    label: 'opencode Zen',
    defaultModel: 'mimo-v2.5',
    models: [
      { id: 'mimo-v2.5', disableThinking: true },
      { id: 'deepseek-v4-flash', disableThinking: true },
      { id: 'gpt-5.6-luna', disableThinking: true },
    ],
  },
  gemini: {
    label: 'Google Gemini',
    defaultModel: 'gemini-3.5-flash-lite',
    models: [
      { id: 'gemini-3.1-flash-lite' },
      { id: 'gemini-3.5-flash-lite' },
      { id: 'gemini-3.5-flash' },
      { id: 'gemini-3.7-flash' },
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
  return PROVIDER_REGISTRY[type].models.map((model) => model.id)
}

export function shouldDisableThinking(config: ProviderConfig): boolean {
  return PROVIDER_REGISTRY[config.type].models.some(
    (model) => model.id === config.model && model.disableThinking,
  )
}
