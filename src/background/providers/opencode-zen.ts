import { OpenAiProvider } from './openai'
import type { ProviderConfig, ProviderRequestContext, ProviderSecret } from './types'

const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/go/v1'

export class OpencodeZenProvider extends OpenAiProvider {
  constructor(
    config: ProviderConfig,
    secret: ProviderSecret,
    private readonly requestContext?: ProviderRequestContext,
  ) {
    super(config, secret, OPENCODE_ZEN_BASE_URL, 'opencode Zen')
  }

  protected override extraChatCompletionBody(): Record<string, unknown> {
    return this.shouldDisableThinking() ? { thinking: { type: 'disabled' } } : {}
  }

  protected override extraChatCompletionHeaders(): Record<string, string> {
    return this.requestContext?.sessionId
      ? { 'x-opencode-session': this.requestContext.sessionId }
      : {}
  }
}
