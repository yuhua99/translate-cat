import { afterEach, describe, expect, test } from 'bun:test'
import {
  CAPTION_AVAILABILITY_RESPONSE_EVENT,
  CAPTION_AVAILABILITY_REQUEST_EVENT,
} from '../../src/youtube/caption-capture-event'
import {
  getCaptionAvailability,
  waitForCaptionAvailability,
} from '../../src/youtube/caption-availability'

const originalWindow = globalThis.window
const originalDocument = globalThis.document
const originalLocation = globalThis.location

interface AvailabilityResponse {
  hasCaptionTracks?: boolean
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

  if (originalLocation === undefined) {
    Reflect.deleteProperty(globalThis, 'location')
  } else {
    globalThis.location = originalLocation
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

  test('returns not-ready when player response has no caption tracks yet', async () => {
    installDomMock({} as HTMLButtonElement, {
      hasClosedCaptions: false,
      hasPlayerResponse: true,
    })

    await expect(getCaptionAvailability()).resolves.toBe('not-ready')
  })

  test('returns available when player response has caption tracks', async () => {
    installDomMock({} as HTMLButtonElement, {
      hasCaptionTracks: true,
      hasClosedCaptions: true,
      hasPlayerResponse: true,
    })

    await expect(getCaptionAvailability()).resolves.toBe('available')
  })
})

describe('waitForCaptionAvailability', () => {
  test('shares rechecks and detects caption tracks that arrive late', async () => {
    let queries = 0
    installDomMock({} as HTMLButtonElement, () => {
      const ready = ++queries === 3
      return { hasPlayerResponse: true, hasCaptionTracks: ready, hasClosedCaptions: ready }
    })

    const result = waitForCaptionAvailability()
    expect(waitForCaptionAvailability()).toBe(result)
    await expect(result).resolves.toBe('available')
    expect(queries).toBe(3)
  })

  test('does not retry when the player supplies an empty caption track list', async () => {
    let queries = 0
    installDomMock({} as HTMLButtonElement, () => {
      queries++
      return { hasPlayerResponse: true, hasCaptionTracks: true, hasClosedCaptions: false }
    })

    await expect(waitForCaptionAvailability()).resolves.toBe('unavailable')
    expect(queries).toBe(1)
  })

  test('gives up after bounded rechecks when caption metadata never arrives', async () => {
    let queries = 0
    installDomMock({} as HTMLButtonElement, () => {
      queries++
      return { hasPlayerResponse: true, hasClosedCaptions: false }
    })

    await expect(waitForCaptionAvailability()).resolves.toBe('unavailable')
    expect(queries).toBe(21)
  })
})

function installDomMock(
  captionButton: HTMLButtonElement | null,
  response: AvailabilityResponse | (() => AvailabilityResponse),
): void {
  const listeners = new Set<(event: MessageEvent) => void>()
  const windowMock = {
    setTimeout(callback: () => void, delay: number) {
      if (delay === 500) {
        queueMicrotask(callback)
        return 0
      }
      return globalThis.setTimeout(callback, delay)
    },
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
              ...(typeof response === 'function' ? response() : response),
            },
          } as MessageEvent)
        }
      })
    },
  } as Window

  globalThis.window = windowMock
  globalThis.location = new URL('https://www.youtube.com/watch?v=video-1') as unknown as Location
  globalThis.document = {
    querySelector: () => captionButton,
  } as unknown as Document
}
