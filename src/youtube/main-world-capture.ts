import {
  CAPTION_AVAILABILITY_REQUEST_EVENT,
  CAPTION_AVAILABILITY_RESPONSE_EVENT,
  CAPTION_EVENT,
  CAPTION_RELOAD_COOLDOWN_EVENT,
  CAPTION_RELOAD_REQUEST_EVENT,
  isTimedTextUrl,
  type CaptionsCapturedEventDetail,
} from './caption-capture-event'
import { parseYouTubeVideoId } from './video-load'

interface YoutubePlayerElement extends HTMLElement {
  getPlayerResponse?: () => YoutubePlayerResponse | undefined
}

interface YoutubePlayerResponse {
  videoDetails?: { videoId?: string }
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: unknown[]
    }
  }
}

declare global {
  interface Window {
    __simpleTranslatorCaptionCaptureInstalled?: boolean
  }
}

const DEFAULT_CAPTION_COOLDOWN_MS = 60_000
let captionCooldownUntil = 0

if (!window.__simpleTranslatorCaptionCaptureInstalled) {
  window.__simpleTranslatorCaptionCaptureInstalled = true
  installXhrCapture()
  installFetchCapture()
  installCaptionAvailabilityHandler()
  window.addEventListener(CAPTION_RELOAD_REQUEST_EVENT, (event) => {
    const retryAfterMs = captionCooldownUntil - Date.now()
    if (retryAfterMs <= 0) return

    event.preventDefault()
    window.dispatchEvent(new CustomEvent(CAPTION_RELOAD_COOLDOWN_EVENT, { detail: retryAfterMs }))
  })
}

function pauseCaptionReloads(retryAfter: string | null): void {
  const now = Date.now()
  const value = retryAfter?.trim() ?? ''
  let until = NaN
  if (/^\d+$/.test(value)) {
    until = now + Number(value) * 1_000
  } else if (/[a-z]/i.test(value)) {
    until = Date.parse(value)
  }
  captionCooldownUntil = Math.max(
    captionCooldownUntil,
    Number.isFinite(until) ? until : now + DEFAULT_CAPTION_COOLDOWN_MS,
  )
}

function dispatchCaptionCapture(detail: CaptionsCapturedEventDetail): void {
  window.dispatchEvent(new CustomEvent<CaptionsCapturedEventDetail>(CAPTION_EVENT, { detail }))
  window.postMessage({ source: 'simple-translator', type: CAPTION_EVENT, detail }, '*')
}

function installXhrCapture(): void {
  // oxlint-disable-next-line typescript-eslint/unbound-method -- invoked via Reflect.apply with explicit this
  const originalOpen = XMLHttpRequest.prototype.open
  // oxlint-disable-next-line typescript-eslint/unbound-method -- invoked via Reflect.apply with explicit this
  const originalSend = XMLHttpRequest.prototype.send
  const requestUrls = new WeakMap<XMLHttpRequest, string>()

  function patchedOpen(this: XMLHttpRequest, method: string, url: string | URL): void
  function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async: boolean,
    username?: string | null,
    password?: string | null,
  ): void
  function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    try {
      requestUrls.delete(this)
      requestUrls.set(this, String(url))
    } catch {}

    if (async === undefined) {
      Reflect.apply(originalOpen, this, [method, url])
    } else {
      Reflect.apply(originalOpen, this, [method, url, async, username, password])
    }
  }

  XMLHttpRequest.prototype.open = patchedOpen

  XMLHttpRequest.prototype.send = function patchedSend(
    ...args: Parameters<XMLHttpRequest['send']>
  ): void {
    try {
      const url = requestUrls.get(this)
      if (url && isTimedTextUrl(url)) {
        this.addEventListener('loadend', () => captureXhrResponse(this, url), { once: true })
      }
    } catch {}

    originalSend.apply(this, args)
  }
}

function captureXhrResponse(xhr: XMLHttpRequest, url: string): void {
  try {
    if (xhr.status === 429) {
      pauseCaptionReloads(xhr.getResponseHeader('Retry-After'))
      return
    }
    if (xhr.status < 200 || xhr.status >= 300) return
    if (xhr.responseType !== '' && xhr.responseType !== 'text') return
    const responseText = xhr.responseText
    dispatchCaptionCapture({ url, responseText })
  } catch {}
}

function installFetchCapture(): void {
  const originalFetch = window.fetch

  async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const response = await originalFetch.call(window, input, init)
    void captureFetchResponse(input, response).catch(() => {})
    return response
  }

  window.fetch = Object.assign(patchedFetch, originalFetch)
}

async function captureFetchResponse(input: RequestInfo | URL, response: Response): Promise<void> {
  const url = getFetchUrl(input)
  if (!isTimedTextUrl(url)) return
  if (response.status === 429) {
    pauseCaptionReloads(response.headers.get('Retry-After'))
    return
  }
  if (!response.ok) return

  const responseText = await response.clone().text()
  dispatchCaptionCapture({ url, responseText })
}

function installCaptionAvailabilityHandler(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const data = event.data as { requestId?: string; source?: string; type?: string }
    if (data.source !== 'simple-translator' || data.type !== CAPTION_AVAILABILITY_REQUEST_EVENT)
      return

    try {
      const response = readPlayerResponse()
      const currentVideoId = parseYouTubeVideoId(new URL(location.href))
      const responseVideoId = response?.videoDetails?.videoId
      const isCurrentVideo =
        !currentVideoId || !responseVideoId || currentVideoId === responseVideoId
      const captionTracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      window.postMessage(
        {
          source: 'simple-translator',
          type: CAPTION_AVAILABILITY_RESPONSE_EVENT,
          requestId: data.requestId,
          hasPlayerResponse: Boolean(response) && isCurrentVideo,
          hasCaptionTracks: Array.isArray(captionTracks),
          hasClosedCaptions: Array.isArray(captionTracks) && captionTracks.length > 0,
        },
        '*',
      )
    } catch (error) {
      window.postMessage(
        {
          source: 'simple-translator',
          type: CAPTION_AVAILABILITY_RESPONSE_EVENT,
          requestId: data.requestId,
          error: error instanceof Error ? error.message : String(error),
        },
        '*',
      )
    }
  })
}

function readPlayerResponse(): YoutubePlayerResponse | undefined {
  const player = document.getElementById('movie_player') as YoutubePlayerElement | null
  return player?.getPlayerResponse?.()
}

function getFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input
  }

  if (input instanceof URL) {
    return input.toString()
  }

  return input.url
}
