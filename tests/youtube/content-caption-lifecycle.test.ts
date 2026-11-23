import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS, type ExtensionMessage } from '../../src/shared/messages'
import {
  CAPTION_AVAILABILITY_RESPONSE_EVENT,
  CAPTION_EVENT,
  CAPTION_RELOAD_COOLDOWN_EVENT,
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
    expect(document.getElementById(HIDER_ID)).toBeNull()

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
    expect(document.getElementById(HIDER_ID)).not.toBeNull()
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

test('a page cooldown defers caption reloads and resumes on the same video', async () => {
  const dom = installCaptionPage()
  let retryAfterMs = 0
  window.addEventListener(CAPTION_RELOAD_REQUEST_EVENT, (event) => {
    if (retryAfterMs === 0) return
    event.preventDefault()
    window.dispatchEvent(new CustomEvent(CAPTION_RELOAD_COOLDOWN_EVENT, { detail: retryAfterMs }))
  })

  try {
    await import('../../src/content/index.ts?caption-cooldown')
    await Bun.sleep(0)
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('true')

    retryAfterMs = 60_000
    dom.fireCaptionRetry()
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('true')
    expect(dom.captionRetriesAt(60_000)).toHaveLength(1)

    dom.captionButton.click()
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('false')
    retryAfterMs = 50_000
    dom.navigate('video-2')
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('false')
    expect(dom.captionRetriesAt(60_000)).toHaveLength(0)
    expect(dom.captionRetriesAt(50_000)).toHaveLength(1)

    retryAfterMs = 0
    dom.fireCaptionRetry(50_000)
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('true')
    expect(dom.captionRetriesAt(1_000)).toHaveLength(1)

    retryAfterMs = 60_000
    dom.navigate('video-3')
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('true')
    expect(dom.captionRetriesAt(60_000)).toHaveLength(1)

    dom.captionButton.click()
    retryAfterMs = 0
    dom.fireCaptionRetry(60_000)
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('false')
    expect(dom.captionRetriesAt(1_000)).toHaveLength(0)

    retryAfterMs = 60_000
    dom.navigate('video-4')
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('false')
    dom.captionButton.click()

    retryAfterMs = 30_000
    dom.fireCaptionRetry(60_000)
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('true')
    expect(dom.captionRetriesAt(30_000)).toHaveLength(1)

    retryAfterMs = 0
    dom.fireCaptionRetry(30_000)
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('false')
    dom.fireCaptionRetry(250)
    await Bun.sleep(0)
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('true')
  } finally {
    dom.restore()
  }
})

test('retries an ignored CC enable and only re-enables the current button if it is off', async () => {
  const dom = installCaptionPage()
  dom.ignoreNextCaptionClick()

  try {
    await import('../../src/content/index.ts?cc-reload')
    await Bun.sleep(0)
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('false')
    dom.fireCaptionRetry()
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('true')
    expect(dom.captionRetriesAt(1_000)).toHaveLength(0)

    dom.navigate('video-2')
    const previousButton = dom.captionButton
    expect(previousButton.getAttribute('aria-pressed')).toBe('false')
    dom.reportCcMutation('true')
    dom.replaceCaptionButton(true)
    dom.fireCaptionRetry(250)
    await Bun.sleep(0)
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('true')
    expect(previousButton.getAttribute('aria-pressed')).toBe('false')

    dom.navigate('video-3')
    dom.replaceCaptionButton(false)
    dom.fireCaptionRetry(250)
    await Bun.sleep(0)
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('true')
  } finally {
    dom.restore()
  }
})

test('manual native CC off stops AI and cancels a cooldown while waiting for captions', async () => {
  const dom = installCaptionPage()

  try {
    await import('../../src/content/index.ts?native-cc-off')
    await Bun.sleep(0)
    expect(dom.aiButton.getAttribute('aria-pressed')).toBe('true')
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('true')
    expect(document.getElementById(HIDER_ID)).toBeNull()

    window.addEventListener(CAPTION_RELOAD_REQUEST_EVENT, (event) => {
      event.preventDefault()
      window.dispatchEvent(new CustomEvent(CAPTION_RELOAD_COOLDOWN_EVENT, { detail: 60_000 }))
    })
    dom.fireCaptionRetry()
    expect(dom.captionRetriesAt(60_000)).toHaveLength(1)
    dom.toggleNativeCc()
    await Bun.sleep(0)

    expect(dom.aiButton.getAttribute('aria-pressed')).toBe('false')
    expect(dom.captionButton.getAttribute('aria-pressed')).toBe('false')
    expect(dom.captionRetriesAt(60_000)).toHaveLength(0)
    expect(document.getElementById(HIDER_ID)).toBeNull()
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
  const ccObservers: MutationCallback[] = []
  let nextTimeoutId = 0
  const aiButton = { ...element(), querySelector: () => null }
  nodes.set('simple-translator-toggle', aiButton)
  const statusMessage = element()
  const statusOverlay = { ...element(), querySelector: () => statusMessage }
  nodes.set('simple-translator-status-overlay', statusOverlay)
  let ignoreNextCaptionClick = false
  function makeCaptionButton(on: boolean) {
    const button = {
      ...element(),
      click() {
        if (ignoreNextCaptionClick) {
          ignoreNextCaptionClick = false
          return
        }
        this.setAttribute('aria-pressed', String(this.getAttribute('aria-pressed') !== 'true'))
      },
    }
    button.setAttribute('aria-pressed', String(on))
    return button
  }
  let captionButton = makeCaptionButton(false)
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
      constructor(private readonly callback: MutationCallback) {}
      observe(_target: Node, options: MutationObserverInit) {
        if (options.attributeFilter?.includes('aria-pressed')) ccObservers.push(this.callback)
      }
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
    get captionButton() {
      return captionButton
    },
    ignoreNextCaptionClick() {
      ignoreNextCaptionClick = true
    },
    replaceCaptionButton(on: boolean) {
      captionButton = makeCaptionButton(on)
    },
    toggleNativeCc() {
      const oldValue = captionButton.getAttribute('aria-pressed')
      captionButton.click()
      this.reportCcMutation(oldValue)
    },
    reportCcMutation(oldValue: string | null) {
      const record = { target: captionButton, oldValue } as unknown as MutationRecord
      for (const observer of ccObservers) observer([record], {} as MutationObserver)
    },
    statusMessage,
    captionRetriesAt(delayMs: number) {
      return [...timeouts.values()].filter(({ delay }) => delay === delayMs)
    },
    fireCaptionRetry(delayMs = 1_000) {
      const retry = [...timeouts].find(([, { delay }]) => delay === delayMs)
      if (!retry) throw new Error('Caption retry was not scheduled')
      const [id, { callback }] = retry
      timeouts.delete(id)
      callback()
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
