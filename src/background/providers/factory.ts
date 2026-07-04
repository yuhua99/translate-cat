import { AnthropicProvider } from './anthropic'
import { GeminiProvider } from './gemini'
import { OpenAiProvider } from './openai'
import { OpencodeZenProvider } from './opencode-zen'
import type { AiProvider, ProviderConfig, ProviderSecret } from './types'

export function createProvider(config: ProviderConfig, secret: ProviderSecret): AiProvider {
  if (config.type === 'openai') {
    return new OpenAiProvider(config, secret)
  }

  if (config.type === 'anthropic') {
    return new AnthropicProvider(config, secret)
  }

  if (config.type === 'opencodeZen') {
    return new OpencodeZenProvider(config, secret)
  }

  if (config.type === 'gemini') {
    return new GeminiProvider(config, secret)
  }

  throw new Error(`Unsupported provider type: ${String(config.type)}`)
}
