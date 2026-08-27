import { OpenAiProvider } from './openai'
import type { ProviderConfig, ProviderSecret } from './types'

const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/go/v1'

export class OpencodeZenProvider extends OpenAiProvider {
  constructor(config: ProviderConfig, secret: ProviderSecret) {
    super(config, secret, OPENCODE_ZEN_BASE_URL, 'opencode Zen')
  }

  protected override extraChatCompletionBody(): Record<string, unknown> {
    return this.shouldDisableThinking() ? { thinking: { type: 'disabled' } } : {}
  }
}
