import { AnthropicProvider } from './anthropic'
import { CodexProvider } from './codex'
import { GeminiProvider } from './gemini'
import { OpenAiProvider } from './openai'
import { OpencodeZenProvider } from './opencode-zen'
import type { ProviderStorageArea } from './storage'
import type { AiProvider, ProviderConfig, ProviderRequestContext, ProviderSecret } from './types'

export function createProvider(
  config: ProviderConfig,
  secret: ProviderSecret,
  secretStorage: ProviderStorageArea,
  requestContext?: ProviderRequestContext,
): AiProvider {
  if (config.type === 'openai') {
    return new OpenAiProvider(config, secret)
  }

  if (config.type === 'codex') {
    return new CodexProvider(config, secret, secretStorage)
  }

  if (config.type === 'anthropic') {
    return new AnthropicProvider(config, secret)
  }

  if (config.type === 'opencodeZen') {
    return new OpencodeZenProvider(config, secret, requestContext)
  }

  if (config.type === 'gemini') {
    return new GeminiProvider(config, secret)
  }

  throw new Error(`Unsupported provider type: ${String(config.type)}`)
}
