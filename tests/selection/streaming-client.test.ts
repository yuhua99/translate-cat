import { describe, expect, test } from 'bun:test'
import {
  createSelectionStreamingClient,
  type SelectionStreamingCallbacks,
  type SelectionTranslationPort,
} from '../../src/selection/streaming-client'

type Listener<T> = (message: T) => void

function createPort(): {
  port: SelectionTranslationPort
  posted: unknown[]
  emit(message: unknown): void
  disconnect(): void
  disconnectCount(): number
} {
  const messages: Array<Listener<unknown>> = []
  const disconnects: Array<Listener<unknown>> = []
  const posted: unknown[] = []
  let count = 0
  return {
    port: {
      postMessage(message): void {
        posted.push(message)
      },
      disconnect(): void {
        count += 1
        for (const listener of disconnects) listener(undefined)
      },
      onMessage: {
        addListener(listener): void {
          messages.push(listener)
        },
      },
      onDisconnect: {
        addListener(listener): void {
          disconnects.push(listener)
        },
      },
    },
    posted,
    emit(message): void {
      for (const listener of messages) listener(message)
    },
    disconnect(): void {
      for (const listener of disconnects) listener(undefined)
    },
    disconnectCount(): number {
      return count
    },
  }
}

function createCallbacks(): {
  events: string[]
  callbacks: SelectionStreamingCallbacks
} {
  const events: string[] = []
  return {
    events,
    callbacks: {
      started: () => events.push('started'),
      delta: (text) => events.push(`delta:${text}`),
      reset: () => events.push('reset'),
      complete: () => events.push('complete'),
      error: (error) => events.push(`error:${error}`),
      disconnected: () => events.push('disconnected'),
    },
  }
}

describe('createSelectionStreamingClient', () => {
  test('sends a translation request without crypto.randomUUID', () => {
    const connection = createPort()
    const client = createSelectionStreamingClient(() => connection.port)
    const { callbacks } = createCallbacks()
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} })

    let handle: ReturnType<typeof client.translate>
    try {
      handle = client.translate({ text: 'Hello', targetLanguage: 'zh-TW' }, callbacks)
    } finally {
      if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor)
      else Reflect.deleteProperty(globalThis, 'crypto')
    }

    expect(connection.posted).toEqual([
      {
        type: 'translate',
        requestId: handle.requestId,
        text: 'Hello',
        targetLanguage: 'zh-TW',
      },
    ])
    expect(handle.requestId).toMatch(/^sel-\d+$/)
  })

  test('consumes streaming events in order', () => {
    const connection = createPort()
    const client = createSelectionStreamingClient(() => connection.port)
    const { callbacks, events } = createCallbacks()
    const handle = client.translate({ text: 'Hello', targetLanguage: 'zh-TW' }, callbacks)

    connection.emit({ type: 'started', requestId: handle.requestId })
    connection.emit({ type: 'delta', requestId: handle.requestId, text: '你' })
    connection.emit({ type: 'reset', requestId: handle.requestId })
    connection.emit({ type: 'delta', requestId: handle.requestId, text: '您好' })
    connection.emit({ type: 'complete', requestId: handle.requestId })

    expect(events).toEqual(['started', 'delta:你', 'reset', 'delta:您好', 'complete'])
    expect(connection.disconnectCount()).toBe(1)
  })

  test('reports a disconnect before a terminal event', () => {
    const connection = createPort()
    const client = createSelectionStreamingClient(() => connection.port)
    const { callbacks, events } = createCallbacks()
    client.translate({ text: 'Hello', targetLanguage: 'zh-TW' }, callbacks)

    connection.disconnect()

    expect(events).toEqual(['disconnected'])
  })

  test('does not report an error for cancellation', () => {
    const connection = createPort()
    const client = createSelectionStreamingClient(() => connection.port)
    const { callbacks, events } = createCallbacks()
    const handle = client.translate({ text: 'Hello', targetLanguage: 'zh-TW' }, callbacks)

    handle.cancel()

    expect(events).toEqual([])
    expect(connection.disconnectCount()).toBe(1)
  })

  test('ignores events for a stale request', () => {
    const connection = createPort()
    const client = createSelectionStreamingClient(() => connection.port)
    const { callbacks, events } = createCallbacks()
    client.translate({ text: 'Hello', targetLanguage: 'zh-TW' }, callbacks)

    connection.emit({ type: 'delta', requestId: 'stale', text: 'ignored' })

    expect(events).toEqual([])
  })
})
