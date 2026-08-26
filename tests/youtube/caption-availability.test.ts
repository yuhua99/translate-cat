import { afterEach, describe, expect, test } from 'bun:test'
import {
  CAPTION_AVAILABILITY_RESPONSE_EVENT,
  CAPTION_AVAILABILITY_REQUEST_EVENT,
} from '../../src/youtube/caption-capture-event'
import {
  getCaptionAvailability,
  hasAvailableCaptions,
} from '../../src/youtube/caption-availability'

const originalWindow = globalThis.window
const originalDocument = globalThis.document

interface AvailabilityResponse {
  hasClosedCaptions: boolean
  hasPlayerResponse: boolean
}

afterEach(() => {
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, 'window')
  } else {
    globalThis.window = originalWindow
  }

  if (originalDocument === undefined) {
    Reflect.deleteProperty(globalThis, 'document')
  } else {
    globalThis.document = originalDocument
  }
})

describe('getCaptionAvailability', () => {
  test('returns not-ready when caption button is missing', async () => {
    installDomMock(null, { hasClosedCaptions: true, hasPlayerResponse: true })

    await expect(getCaptionAvailability()).resolves.toBe('not-ready')
  })

  test('returns not-ready when player response is missing', async () => {
    installDomMock({} as HTMLButtonElement, {
      hasClosedCaptions: false,
      hasPlayerResponse: false,
    })

    await expect(getCaptionAvailability()).resolves.toBe('not-ready')
  })

  test('returns unavailable when player response has no caption tracks', async () => {
    installDomMock({} as HTMLButtonElement, {
      hasClosedCaptions: false,
      hasPlayerResponse: true,
    })

    await expect(getCaptionAvailability()).resolves.toBe('unavailable')
  })

  test('returns available when player response has caption tracks', async () => {
    installDomMock({} as HTMLButtonElement, {
      hasClosedCaptions: true,
      hasPlayerResponse: true,
    })

    await expect(getCaptionAvailability()).resolves.toBe('available')
  })
})

describe('hasAvailableCaptions', () => {
  test('returns false when caption button is missing', async () => {
    installDomMock(null, { hasClosedCaptions: true, hasPlayerResponse: true })

    await expect(hasAvailableCaptions()).resolves.toBe(false)
  })

  test('returns true when player response has caption tracks', async () => {
    installDomMock({} as HTMLButtonElement, {
      hasClosedCaptions: true,
      hasPlayerResponse: true,
    })

    await expect(hasAvailableCaptions()).resolves.toBe(true)
  })

  test('returns false when player response has no caption tracks', async () => {
    installDomMock({} as HTMLButtonElement, {
      hasClosedCaptions: false,
      hasPlayerResponse: true,
    })

    await expect(hasAvailableCaptions()).resolves.toBe(false)
  })
})

function installDomMock(
  captionButton: HTMLButtonElement | null,
  response: AvailabilityResponse,
): void {
  const listeners = new Set<(event: MessageEvent) => void>()
  const windowMock = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'message') listeners.add(listener as (event: MessageEvent) => void)
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'message') listeners.delete(listener as (event: MessageEvent) => void)
    },
    postMessage: (message: { requestId?: string; source?: string; type?: string }) => {
      expect(message.source).toBe('simple-translator')
      expect(message.type).toBe(CAPTION_AVAILABILITY_REQUEST_EVENT)

      queueMicrotask(() => {
        for (const listener of listeners) {
          listener({
            source: windowMock,
            data: {
              source: 'simple-translator',
              type: CAPTION_AVAILABILITY_RESPONSE_EVENT,
              requestId: message.requestId,
              ...response,
            },
          } as MessageEvent)
        }
      })
    },
  } as Window

  globalThis.window = windowMock
  globalThis.document = {
    querySelector: () => captionButton,
  } as unknown as Document
}
