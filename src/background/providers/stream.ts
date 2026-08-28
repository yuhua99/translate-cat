import {
  ProviderHttpError,
  ProviderJsonParseError,
  ProviderNetworkError,
  ProviderSseError,
} from './errors'

export interface SseMessage {
  event: string
  data: string
}

/**
 * Reads a provider SSE response, stopping at the first defined `onMessage` result.
 * Returns undefined when the stream ends without one.
 */
export async function readProviderSse<T>(
  response: Response,
  label: string,
  signal: AbortSignal | undefined,
  onMessage: (message: SseMessage) => T | undefined,
): Promise<T | undefined> {
  if (!response.body) {
    throw new ProviderJsonParseError(`${label} response did not include an SSE body`)
  }

  try {
    for await (const message of readSse(response.body, signal)) {
      const result = onMessage(message)
      if (result !== undefined) return result
    }
  } catch (error) {
    if (
      signal?.aborted ||
      error instanceof ProviderHttpError ||
      error instanceof ProviderJsonParseError ||
      error instanceof ProviderSseError
    ) {
      throw error
    }
    throw new ProviderNetworkError(error instanceof Error ? error.message : String(error), {
      cause: error,
    })
  }

  return undefined
}

export async function* readSse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseMessage, void, void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  let cancellation: Promise<void> | undefined
  const cancel = (reason?: unknown): Promise<void> => {
    cancellation ??= reader.cancel(reason).catch(() => undefined)
    return cancellation
  }
  const abort = () => {
    void cancel(signal?.reason)
  }

  signal?.addEventListener('abort', abort, { once: true })

  try {
    await throwIfAborted(signal, cancel)

    while (true) {
      const { done, value } = await reader.read()
      await throwIfAborted(signal, cancel)

      if (done) break

      for (const message of parser.push(decoder.decode(value, { stream: true }))) {
        await throwIfAborted(signal, cancel)
        yield message
      }

      if (parser.done) {
        await cancel()
        return
      }
    }

    for (const message of parser.push(decoder.decode())) {
      await throwIfAborted(signal, cancel)
      yield message
    }
    for (const message of parser.end()) {
      await throwIfAborted(signal, cancel)
      yield message
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    await cancel(signal?.aborted ? signal.reason : undefined)
    reader.releaseLock()
  }
}

export function getSseError(
  error: unknown,
  fields: readonly ('code' | 'type')[] = ['code', 'type'],
): { code?: string; message: string } {
  if (typeof error === 'string') return { message: error }
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown; type?: unknown }
    const fieldValue = fields
      .map((field) => value[field])
      .find((value) => typeof value === 'string')
    const code = typeof fieldValue === 'string' ? fieldValue : undefined
    const message = typeof value.message === 'string' ? value.message : code
    return { code, message: message ?? 'unknown error' }
  }
  return { message: 'unknown error' }
}

export function isSseRateLimited(error: { code?: string; message: string }): boolean {
  return (
    error.code?.toLowerCase().includes('rate_limit') ||
    /rate[ -]?limit(?:ed)?|too many requests|\b429\b/iu.test(error.message)
  )
}

async function throwIfAborted(
  signal: AbortSignal | undefined,
  cancel: (reason?: unknown) => Promise<void>,
): Promise<void> {
  if (!signal?.aborted) return
  await cancel(signal.reason)
  throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

class SseParser {
  done = false
  private data = ''
  private event = ''
  private line = ''
  private afterCarriageReturn = false

  push(chunk: string): SseMessage[] {
    const messages: SseMessage[] = []

    for (const character of chunk) {
      if (this.done) break

      if (this.afterCarriageReturn) {
        this.afterCarriageReturn = false
        if (character === '\n') continue
      }

      if (character === '\r') {
        this.processLine(messages)
        this.line = ''
        this.afterCarriageReturn = true
      } else if (character === '\n') {
        this.processLine(messages)
        this.line = ''
      } else {
        this.line += character
      }
    }

    return messages
  }

  end(): SseMessage[] {
    const messages: SseMessage[] = []

    if (!this.done && this.line) {
      this.processLine(messages)
      this.line = ''
    }
    if (!this.done) this.dispatch(messages)

    return messages
  }

  private processLine(messages: SseMessage[]): void {
    if (!this.line) {
      this.dispatch(messages)
      return
    }
    if (this.line.startsWith(':')) return

    const separator = this.line.indexOf(':')
    const field = separator < 0 ? this.line : this.line.slice(0, separator)
    let value = separator < 0 ? '' : this.line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'event') {
      this.event = value
    } else if (field === 'data') {
      this.data += `${value}\n`
    }
  }

  private dispatch(messages: SseMessage[]): void {
    if (!this.data) {
      this.event = ''
      return
    }

    const data = this.data.slice(0, -1)
    const event = this.event || 'message'
    this.data = ''
    this.event = ''

    if (data === '[DONE]') {
      this.done = true
      return
    }

    messages.push({ event, data })
  }
}
