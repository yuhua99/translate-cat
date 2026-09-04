import { describe, expect, test } from 'bun:test'
import {
  createSelectionTranslationPortHandler,
  registerSelectionTranslationPort,
  type SelectionTranslationPort,
} from '../../src/background/selection-stream'
import {
  SELECTION_TRANSLATION_PORT,
  type SelectionTranslationEvent,
} from '../../src/shared/messages'

class FakePort implements SelectionTranslationPort {
  readonly messages: SelectionTranslationEvent[] = []
  disconnectCalls = 0
  private readonly disconnectListeners: Array<() => void> = []
  private readonly messageListeners: Array<(message: unknown) => void> = []

  constructor(
    readonly name: string,
    readonly sender?: { documentId?: string },
  ) {}

  onDisconnect = {
    addListener: (callback: () => void) => this.disconnectListeners.push(callback),
  }
  onMessage = {
    addListener: (callback: (message: unknown) => void) => this.messageListeners.push(callback),
  }

  postMessage(message: SelectionTranslationEvent): void {
    this.messages.push(message)
  }

  send(message: unknown): void {
    for (const listener of this.messageListeners) listener(message)
  }

  disconnect(): void {
    this.disconnectCalls += 1
    for (const listener of this.disconnectListeners) listener()
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('selection translation port', () => {
  test('only handles the selection translation port', () => {
    let calls = 0
    const handler = createSelectionTranslationPortHandler(async () => {
      calls += 1
      return { ok: true }
    })
    const port = new FakePort('other-port')

    handler(port)
    port.send({ type: 'translate', requestId: 'request-1', text: 'Hello', targetLanguage: 'zh-TW' })

    expect(calls).toBe(0)
    expect(port.messages).toEqual([])
  })

  test('registers the handler and streams ordered events for one request', async () => {
    let listener: ((port: SelectionTranslationPort) => void) | undefined
    let receivedRequestContext: unknown
    registerSelectionTranslationPort(
      { addListener: (callback) => (listener = callback) },
      async (_request, lifecycle, requestContext) => {
        receivedRequestContext = requestContext
        lifecycle.onDelta('你')
        lifecycle.onDelta('好')
        lifecycle.onReset()
        lifecycle.onDelta('您好')
        return { ok: true }
      },
    )
    const port = new FakePort(SELECTION_TRANSLATION_PORT, { documentId: 'selection-session-123' })

    listener?.(port)
    port.send({ type: 'translate', requestId: 'request-1', text: 'Hello', targetLanguage: 'zh-TW' })
    await flush()

    expect(port.messages).toEqual([
      { type: 'started', requestId: 'request-1' },
      { type: 'delta', requestId: 'request-1', text: '你' },
      { type: 'delta', requestId: 'request-1', text: '好' },
      { type: 'reset', requestId: 'request-1' },
      { type: 'delta', requestId: 'request-1', text: '您好' },
      { type: 'complete', requestId: 'request-1' },
    ])
    expect(port.disconnectCalls).toBe(1)
    expect(receivedRequestContext).toEqual({ sessionId: 'selection-session-123' })
  })

  test('ignores a duplicate request and reports empty translation errors', async () => {
    let resolve!: () => void
    const pending = new Promise<void>((done) => (resolve = done))
    const handler = createSelectionTranslationPortHandler(async () => {
      await pending
      return { ok: false, error: 'No translation returned' }
    })
    const port = new FakePort(SELECTION_TRANSLATION_PORT)

    handler(port)
    port.send({ type: 'translate', requestId: 'request-1', text: 'Hello', targetLanguage: 'zh-TW' })
    port.send({ type: 'translate', requestId: 'request-2', text: 'World', targetLanguage: 'zh-TW' })
    resolve()
    await flush()

    expect(port.messages).toEqual([
      { type: 'started', requestId: 'request-1' },
      { type: 'error', requestId: 'request-1', error: 'No translation returned' },
    ])
    expect(port.disconnectCalls).toBe(1)
  })

  test('aborts the translation when the port disconnects', async () => {
    let aborted = false
    const handler = createSelectionTranslationPortHandler(
      async (_request, lifecycle) =>
        await new Promise<{ ok: true }>((resolve) => {
          lifecycle.signal.addEventListener('abort', () => {
            aborted = true
            resolve({ ok: true })
          })
        }),
    )
    const port = new FakePort(SELECTION_TRANSLATION_PORT)

    handler(port)
    port.send({ type: 'translate', requestId: 'request-1', text: 'Hello', targetLanguage: 'zh-TW' })
    port.disconnect()
    await flush()

    expect(aborted).toBe(true)
    expect(port.messages).toEqual([{ type: 'started', requestId: 'request-1' }])
  })
})
