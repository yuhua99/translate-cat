import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS, type ExtensionMessage } from '../../src/shared/messages'
import {
  CAPTION_AVAILABILITY_RESPONSE_EVENT,
  CAPTION_EVENT,
  CAPTION_RELOAD_REQUEST_EVENT,
} from '../../src/youtube/caption-capture-event'

const HIDER_ID = 'simple-translator-hide-native-captions'

test('restores native captions after a fatal AI subtitle error without reloading', async () => {
  const dom = installCaptionPage()

  try {
    await import('../../src/content/index')
    await Bun.sleep(0)
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('true')
    expect(dom.aiButton.getAttribute('aria-pressed')).toBe('true')
    expect(document.getElementById(HIDER_ID)).not.toBeNull()

    window.dispatchEvent(
      new CustomEvent(CAPTION_EVENT, {
        detail: {
          url: 'https://www.youtube.com/api/timedtext?v=video-1&lang=en',
          responseText: JSON.stringify({
            events: [{ tStartMs: 1_000, dDurationMs: 1_000, segs: [{ utf8: 'Hello' }] }],
          }),
        },
      }),
    )
    await Bun.sleep(0)

    expect(dom.statusMessage.textContent).toBe('Unauthorized')
    expect(dom.aiButton.getAttribute('aria-pressed')).toBe('false')
    dom.captionButton.click()
    dom.captionButton.click()
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('true')
    expect(document.getElementById(HIDER_ID)).toBeNull()
  } finally {
    dom.restore()
  }
})

test('a page cooldown blocks the caption retry and subsequent re-arms, but not manual CC', async () => {
  const dom = installCaptionPage()
  let coolingDown = false
  window.addEventListener(CAPTION_RELOAD_REQUEST_EVENT, (event) => {
    if (coolingDown) event.preventDefault()
  })

  try {
    await import('../../src/content/index.ts?caption-cooldown')
    await Bun.sleep(0)
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('true')

    coolingDown = true
    dom.fireCaptionRetry()
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('true')

    dom.captionButton.click()
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('false')
    dom.navigate('video-2')
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('false')

    coolingDown = false
    dom.navigate('video-3')
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('true')
  } finally {
    dom.restore()
  }
})

function element() {
  const attributes = new Map<string, string>()
  return {
    id: '',
    dataset: {} as DOMStringMap,
    style: {},
    textContent: '',
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  }
}

function installCaptionPage() {
  const nodes = new Map<string, ReturnType<typeof element>>()
  const timeouts = new Map<number, { callback: () => void; delay: number }>()
  let nextTimeoutId = 0
  const aiButton = { ...element(), querySelector: () => null }
  nodes.set('simple-translator-toggle', aiButton)
  const statusMessage = element()
  const statusOverlay = { ...element(), querySelector: () => statusMessage }
  nodes.set('simple-translator-status-overlay', statusOverlay)
  const captionButton = {
    ...element(),
    click() {
      this.setAttribute('aria-pressed', String(this.getAttribute('aria-pressed') !== 'true'))
    },
  }
  captionButton.setAttribute('aria-pressed', 'false')
  const documentMock = Object.assign(new EventTarget(), {
    body: {},
    documentElement: {
      append: (node: ReturnType<typeof element>) => nodes.set(node.id, node),
    },
    createElement: () => {
      const node = element()
      return Object.assign(node, { remove: () => nodes.delete(node.id) })
    },
    getElementById: (id: string) => nodes.get(id) ?? null,
    querySelector: (selector: string) => {
      if (selector === '.ytp-subtitles-button') return captionButton
      if (selector === 'video') return { currentTime: 1.5 }
      return null
    },
  })
  const windowMock = Object.assign(new EventTarget(), {
    postMessage(data: { source: string; requestId: string }) {
      this.dispatchEvent(
        Object.assign(new Event('message'), {
          source: this,
          data: {
            ...data,
            type: CAPTION_AVAILABILITY_RESPONSE_EVENT,
            hasPlayerResponse: true,
            hasClosedCaptions: true,
          },
        }),
      )
    },
    setTimeout(callback: () => void, delay: number) {
      timeouts.set(++nextTimeoutId, { callback, delay })
      return nextTimeoutId
    },
    clearTimeout: (id: number) => timeouts.delete(id),
    setInterval: () => 1,
    clearInterval: () => {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  })
  const mocks = {
    window: windowMock,
    document: documentMock,
    location: new URL('https://www.youtube.com/watch?v=video-1'),
    MutationObserver: class {
      observe() {}
    },
    chrome: {
      runtime: {
        async sendMessage(message: ExtensionMessage) {
          if (message.type === 'GET_SETTINGS') {
            return { ok: true, settings: { ...DEFAULT_SETTINGS, enabled: true } }
          }
          if (message.type === 'TRANSLATE_SUBTITLE_AI_PROVIDER') {
            return { ok: false, fatal: true, error: 'Unauthorized' }
          }
          return { ok: true }
        },
      },
      i18n: { getMessage: (key: string, detail?: string) => detail ?? key },
      storage: { onChanged: { addListener: () => {} } },
    },
  }
  const originals = Object.entries(mocks).map(([key, value]) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
    return [key, original] as const
  })
  return {
    aiButton,
    captionButton,
    statusMessage,
    fireCaptionRetry() {
      const retry = [...timeouts.values()].find(({ delay }) => delay === 1_000)
      if (!retry) throw new Error('Caption retry was not scheduled')
      retry.callback()
    },
    navigate(videoId: string) {
      mocks.location.searchParams.set('v', videoId)
      window.dispatchEvent(new Event('yt-navigate-finish'))
    },
    restore() {
      for (const [key, original] of originals) {
        if (original) Object.defineProperty(globalThis, key, original)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}
