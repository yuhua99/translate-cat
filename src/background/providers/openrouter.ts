import { OpenAiProvider } from './openai'
import type { ProviderConfig, ProviderSecret } from './types'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export class OpenRouterProvider extends OpenAiProvider {
  constructor(config: ProviderConfig, secret: ProviderSecret) {
    super(config, secret, OPENROUTER_BASE_URL, 'OpenRouter')
  }

  protected override extraChatCompletionBody(): Record<string, unknown> {
    return this.shouldDisableThinking() ? { reasoning: { effort: 'none' } } : {}
  }

  protected override extraChatCompletionHeaders(): Record<string, string> {
    return { 'X-OpenRouter-Title': 'translate-cat' }
  }
}
