import {
  SELECTION_TRANSLATION_PORT,
  type SelectionTranslationEvent,
  type SelectionTranslationRequest,
  type TranslationError,
} from '../shared/messages'

export interface SelectionTranslationPort {
  name: string
  onDisconnect: {
    addListener(callback: () => void): void
  }
  onMessage: {
    addListener(callback: (message: unknown) => void): void
  }
  postMessage(message: SelectionTranslationEvent): void
  disconnect(): void
}

export interface SelectionTranslationLifecycle {
  signal: AbortSignal
  onDelta: (text: string) => void
  onReset: () => void
}

export type SelectionTranslationHandler = (
  request: SelectionTranslationRequest,
  lifecycle: SelectionTranslationLifecycle,
) => Promise<{ ok: true } | TranslationError>

export function registerSelectionTranslationPort(
  onConnect: { addListener(callback: (port: SelectionTranslationPort) => void): void },
  translate: SelectionTranslationHandler,
): void {
  onConnect.addListener(createSelectionTranslationPortHandler(translate))
}

export function createSelectionTranslationPortHandler(
  translate: SelectionTranslationHandler,
): (port: SelectionTranslationPort) => void {
  return (port) => {
    if (port.name !== SELECTION_TRANSLATION_PORT) return

    const controller = new AbortController()
    let receivedRequest = false

    const post = (event: SelectionTranslationEvent): boolean => {
      if (controller.signal.aborted) return false
      try {
        port.postMessage(event)
        return true
      } catch {
        controller.abort()
        return false
      }
    }

    const postTerminal = (
      event: Extract<SelectionTranslationEvent, { type: 'complete' | 'error' }>,
    ) => {
      if (post(event)) port.disconnect()
    }

    port.onDisconnect.addListener(() => controller.abort())
    port.onMessage.addListener((message) => {
      if (!isSelectionTranslationRequest(message) || receivedRequest) return

      receivedRequest = true
      if (!post({ type: 'started', requestId: message.requestId })) return

      void translate(message, {
        signal: controller.signal,
        onDelta: (text) => {
          if (text) post({ type: 'delta', requestId: message.requestId, text })
        },
        onReset: () => {
          post({ type: 'reset', requestId: message.requestId })
        },
      })
        .then((result) => {
          if (controller.signal.aborted) return
          if (result.ok) {
            postTerminal({ type: 'complete', requestId: message.requestId })
          } else {
            postTerminal({ type: 'error', requestId: message.requestId, error: result.error })
          }
        })
        .catch((error) => {
          if (controller.signal.aborted) return
          postTerminal({
            type: 'error',
            requestId: message.requestId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    })
  }
}

function isSelectionTranslationRequest(message: unknown): message is SelectionTranslationRequest {
  if (!message || typeof message !== 'object') return false
  const request = message as Partial<SelectionTranslationRequest>
  return (
    request.type === 'translate' &&
    typeof request.requestId === 'string' &&
    request.requestId.length > 0 &&
    typeof request.text === 'string' &&
    typeof request.targetLanguage === 'string'
  )
}
