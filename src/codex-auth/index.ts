import {
  CODEX_VERIFICATION_URI,
  exchangeDeviceCode,
  pollDeviceAuthorization,
  requestDeviceCode,
} from '../shared/codex-oauth'
import type { ExtensionMessage, MessageResponse } from '../shared/messages'

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Codex auth DOM missing required element: ${selector}`)
  return element
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sendMessage(message: ExtensionMessage): Promise<MessageResponse> {
  return chrome.runtime.sendMessage(message)
}

document.addEventListener('DOMContentLoaded', () => {
  const loading = requiredElement<HTMLElement>('#auth-loading')
  const code = requiredElement<HTMLElement>('#auth-code')
  const success = requiredElement<HTMLElement>('#auth-success')
  const error = requiredElement<HTMLElement>('#auth-error')
  const userCode = requiredElement<HTMLParagraphElement>('#user-code')
  const copyButton = requiredElement<HTMLButtonElement>('#copy-code')
  const retryButton = requiredElement<HTMLButtonElement>('#retry')
  const errorText = requiredElement<HTMLParagraphElement>('#error-message')
  let controller: AbortController | undefined

  function show(state: 'loading' | 'code' | 'success' | 'error'): void {
    loading.hidden = state !== 'loading'
    code.hidden = state !== 'code'
    success.hidden = state !== 'success'
    error.hidden = state !== 'error'
  }

  async function start(): Promise<void> {
    controller?.abort()
    const nextController = new AbortController()
    controller = nextController
    show('loading')

    try {
      const deviceCode = await requestDeviceCode(nextController.signal)
      if (nextController.signal.aborted) return
      userCode.textContent = deviceCode.userCode
      copyButton.textContent = 'Copy'
      show('code')

      const authorization = await pollDeviceAuthorization(deviceCode, nextController.signal)
      const tokens = await exchangeDeviceCode(
        authorization.authorizationCode,
        authorization.codeVerifier,
        nextController.signal,
      )
      if (!tokens.accountId) throw new Error('Could not read account from token')

      const response = await sendMessage({
        type: 'SET_PROVIDER_SECRET',
        providerType: 'codex',
        secret: { codexAuth: tokens },
      } satisfies ExtensionMessage)
      if (!response.ok) throw new Error(response.error)
      if (nextController.signal.aborted) return
      show('success')
    } catch (caught) {
      if (nextController.signal.aborted) return
      errorText.textContent = errorMessage(caught)
      show('error')
    }
  }

  copyButton.addEventListener('click', () => {
    void navigator.clipboard.writeText(userCode.textContent ?? '').then(() => {
      copyButton.textContent = 'Copied'
      setTimeout(() => {
        copyButton.textContent = 'Copy'
      }, 1_500)
    })
  })

  retryButton.addEventListener('click', () => {
    void start()
  })

  const verificationLink = requiredElement<HTMLAnchorElement>('#verification-link')
  verificationLink.href = CODEX_VERIFICATION_URI

  void start()
})
