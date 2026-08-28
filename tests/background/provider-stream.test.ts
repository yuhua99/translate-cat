import { describe, expect, test } from 'bun:test'
import { ProviderJsonParseError, ProviderSseError } from '../../src/background/providers/errors'
import { readProviderSse, readSse } from '../../src/background/providers/stream'

const encoder = new TextEncoder()

function createStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const messages: unknown[] = []
  for await (const message of readSse(stream)) messages.push(message)
  return messages
}

describe('readSse', () => {
  test('frames LF, CRLF, CR, multiline data, comments, tail frames, and DONE', async () => {
    const messages = await collect(
      createStream([
        ': ignored\r',
        '\nevent: delta\rdata: hel',
        'lo\r\ndata: world\r',
        '\n\rdata: tail\r\n\r\ndata: [DO',
        'NE]\n\ndata: ignored\n\n',
      ]),
    )

    expect(messages).toEqual([
      { event: 'delta', data: 'hello\nworld' },
      { event: 'message', data: 'tail' },
    ])
  })

  test('waits for cancellation before rejecting after abort', async () => {
    let cancelCalls = 0
    let cancelReason: unknown
    let resolveCancel!: () => void
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: first\n\n'))
      },
      cancel(reason) {
        cancelCalls += 1
        cancelReason = reason
        return new Promise<void>((resolve) => {
          resolveCancel = resolve
        })
      },
    })
    const controller = new AbortController()
    const reason = new DOMException('aborted', 'AbortError')
    const iterator = readSse(stream, controller.signal)

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { event: 'message', data: 'first' },
    })

    controller.abort(reason)
    const next = iterator.next()
    let settled = false
    void next.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    await Promise.resolve()
    expect(cancelReason).toBe(reason)
    expect(cancelCalls).toBe(1)
    expect(settled).toBe(false)

    resolveCancel()

    await expect(next).rejects.toBe(reason)
  })

  test('waits for cancellation before returning after abort', async () => {
    let resolveCancel!: () => void
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: first\n\n'))
      },
      cancel() {
        return new Promise<void>((resolve) => {
          resolveCancel = resolve
        })
      },
    })
    const controller = new AbortController()
    const iterator = readSse(stream, controller.signal)

    await iterator.next()
    controller.abort()
    const result = iterator.return()
    let settled = false
    void result.then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)

    resolveCancel()

    await expect(result).resolves.toEqual({ done: true, value: undefined })
  })

  test('rejects responses without an SSE body', async () => {
    await expect(
      readProviderSse(new Response(null), 'Test', undefined, () => undefined),
    ).rejects.toBeInstanceOf(ProviderJsonParseError)
  })

  test('cancels successful early results', async () => {
    let cancelCalls = 0
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: first\n\n'))
      },
      cancel() {
        cancelCalls += 1
      },
    })

    await expect(
      readProviderSse(new Response(stream), 'Test', undefined, () => true),
    ).resolves.toBe(true)
    expect(cancelCalls).toBe(1)
  })

  test('cancels early exits without masking provider errors', async () => {
    let cancelCalls = 0
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: first\n\n'))
      },
      cancel() {
        cancelCalls += 1
        return Promise.reject(new Error('cancel failed'))
      },
    })

    await expect(
      readProviderSse(new Response(stream), 'Test', undefined, () => {
        throw new ProviderSseError('provider failed')
      }),
    ).rejects.toThrow('provider failed')
    expect(cancelCalls).toBe(1)
  })
})
