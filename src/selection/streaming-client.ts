import {
  SELECTION_TRANSLATION_PORT,
  type SelectionTranslationEvent,
  type SelectionTranslationRequest,
} from '../shared/messages'

let requestSeq = 0

interface PortEvent<T> {
  addListener(callback: (message: T) => void): void
}

export interface SelectionTranslationPort {
  postMessage(message: SelectionTranslationRequest): void
  disconnect(): void
  onMessage: PortEvent<unknown>
  onDisconnect: PortEvent<unknown>
}

export interface SelectionStreamingCallbacks {
  started(): void
  delta(text: string): void
  reset(): void
  complete(): void
  error(error: string): void
  disconnected(): void
}

export interface SelectionTranslationHandle {
  requestId: string
  cancel(): void
}

function isSelectionTranslationEvent(message: unknown): message is SelectionTranslationEvent {
  if (!message || typeof message !== 'object') return false
  const event = message as Partial<SelectionTranslationEvent>
  if (typeof event.requestId !== 'string') return false
  if (event.type === 'delta') return typeof event.text === 'string'
  if (event.type === 'error') return typeof event.error === 'string'
  return event.type === 'started' || event.type === 'reset' || event.type === 'complete'
}

export function createSelectionStreamingClient(
  connect: () => SelectionTranslationPort = () =>
    chrome.runtime.connect({ name: SELECTION_TRANSLATION_PORT }),
): {
  translate(
    request: Omit<SelectionTranslationRequest, 'type' | 'requestId'>,
    callbacks: SelectionStreamingCallbacks,
  ): SelectionTranslationHandle
} {
  return {
    translate(request, callbacks): SelectionTranslationHandle {
      const requestId = `sel-${++requestSeq}`
      const port = connect()
      let terminal = false
      let cancelled = false

      port.onMessage.addListener((message) => {
        if (terminal || !isSelectionTranslationEvent(message) || message.requestId !== requestId)
          return
        if (message.type === 'started') callbacks.started()
        if (message.type === 'delta') callbacks.delta(message.text)
        if (message.type === 'reset') callbacks.reset()
        if (message.type === 'complete') {
          terminal = true
          callbacks.complete()
          port.disconnect()
        }
        if (message.type === 'error') {
          terminal = true
          callbacks.error(message.error)
          port.disconnect()
        }
      })

      port.onDisconnect.addListener(() => {
        if (terminal || cancelled) return
        terminal = true
        callbacks.disconnected()
      })

      port.postMessage({ type: 'translate', requestId, ...request })

      return {
        requestId,
        cancel(): void {
          if (terminal || cancelled) return
          cancelled = true
          terminal = true
          port.disconnect()
        },
      }
    },
  }
}
