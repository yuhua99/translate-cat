import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import {
  CAPTION_EVENT,
  CAPTION_RELOAD_REQUEST_EVENT,
} from '../../src/youtube/caption-capture-event'

const timedTextUrl = 'https://www.youtube.com/api/timedtext?v=video-1'
const captions: string[] = []
let fetchResponse: Response

class NativeXhr extends EventTarget {
  status = 200
  responseType = ''
  responseText = 'XHR captions'
  retryAfter: string | null = null

  open(_method: string, _url: string): void {}
  send(): void {
    this.dispatchEvent(new Event('loadend'))
  }
  getResponseHeader(name: string): string | null {
    return name === 'Retry-After' ? this.retryAfter : null
  }
}

const windowMock = Object.assign(new EventTarget(), {
  fetch: async (_input: string) => fetchResponse,
  postMessage: () => {},
})
const originals = new Map<string, PropertyDescriptor | undefined>()

beforeAll(async () => {
  for (const [key, value] of Object.entries({ window: windowMock, XMLHttpRequest: NativeXhr })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  windowMock.addEventListener(CAPTION_EVENT, (event) => {
    captions.push((event as CustomEvent<{ responseText: string }>).detail.responseText)
  })
  await import('../../src/youtube/main-world-capture')
})

afterAll(() => {
  for (const [key, original] of originals) {
    if (original) Object.defineProperty(globalThis, key, original)
    else Reflect.deleteProperty(globalThis, key)
  }
})

test('fetch preserves the original response when cloning or reading captions fails', async () => {
  for (const clone of [
    () => {
      throw new Error('clone failed')
    },
    () => ({ text: () => Promise.reject(new Error('read failed')) }),
  ]) {
    fetchResponse = Object.assign(new Response('original'), { clone })
    const response = await windowMock.fetch(timedTextUrl)
    expect(response).toBe(fetchResponse)
    expect(await response.text()).toBe('original')
  }
  await Bun.sleep(0)
  expect(captions).toEqual([])
})

test('fetch and XHR capture 2xx responses and skip other response bodies', async () => {
  captions.length = 0
  for (const status of [206, 503]) {
    fetchResponse = new Response('fetch captions', { status })
    const clone = spyOn(fetchResponse, 'clone')
    const response = await windowMock.fetch(timedTextUrl)
    expect(response.status).toBe(status)
    expect(await response.text()).toBe('fetch captions')
    expect(clone).toHaveBeenCalledTimes(status === 206 ? 1 : 0)

    const xhr = Object.assign(new NativeXhr(), { status })
    xhr.open('GET', timedTextUrl)
    xhr.send()
    expect(xhr.responseText).toBe('XHR captions')
  }
  expect(captions.sort()).toEqual(['XHR captions', 'fetch captions'])
})

test('429s gate caption reloads using Retry-After seconds, dates, or a 60-second default', async () => {
  captions.length = 0
  let now = Date.UTC(2030, 0, 1)
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  const canReload = () =>
    windowMock.dispatchEvent(new Event(CAPTION_RELOAD_REQUEST_EVENT, { cancelable: true }))

  try {
    const fetch429 = async (url: string, retryAfter?: string) => {
      fetchResponse = new Response('rate limited', {
        status: 429,
        headers: retryAfter ? { 'Retry-After': retryAfter } : {},
      })
      const clone = spyOn(fetchResponse, 'clone')
      expect(await windowMock.fetch(url)).toBe(fetchResponse)
      expect(clone).not.toHaveBeenCalled()
    }
    await fetch429('https://www.youtube.com/watch', '5')
    expect(canReload()).toBe(true)
    await fetch429(timedTextUrl, '5')
    expect(canReload()).toBe(false)
    now += 4_999
    expect(canReload()).toBe(false)
    now += 1
    expect(canReload()).toBe(true)

    const xhr = Object.assign(new NativeXhr(), {
      status: 429,
      retryAfter: new Date(now + 10_000).toUTCString(),
    })
    xhr.open('GET', timedTextUrl)
    xhr.send()
    expect(canReload()).toBe(false)
    await fetch429(timedTextUrl, '1')
    now += 9_999
    expect(canReload()).toBe(false)
    now += 1
    expect(canReload()).toBe(true)

    await fetch429(timedTextUrl)
    now += 59_999
    expect(canReload()).toBe(false)
    now += 1
    expect(canReload()).toBe(true)
    expect(captions).toEqual([])
  } finally {
    clock.mockRestore()
  }
})
