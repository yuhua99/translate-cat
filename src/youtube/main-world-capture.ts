import {
  CAPTION_AVAILABILITY_REQUEST_EVENT,
  CAPTION_AVAILABILITY_RESPONSE_EVENT,
  CAPTION_EVENT,
  CAPTION_REQUEST_EVENT,
  isTimedTextUrl,
  type CaptionsCapturedEventDetail,
} from './caption-capture-event'

interface YoutubePlayerElement extends HTMLElement {
  getPlayerResponse?: () => YoutubePlayerResponse | undefined
}

interface YoutubePlayerResponse {
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

if (!window.__simpleTranslatorCaptionCaptureInstalled) {
  window.__simpleTranslatorCaptionCaptureInstalled = true
  installXhrCapture()
  installFetchCapture()
  installCaptionRequestHandler()
  installCaptionAvailabilityHandler()
}

function dispatchCaptionCapture(detail: CaptionsCapturedEventDetail): void {
  window.dispatchEvent(new CustomEvent<CaptionsCapturedEventDetail>(CAPTION_EVENT, { detail }))
  window.postMessage({ source: 'simple-translator', type: CAPTION_EVENT, detail }, '*')
}

function installXhrCapture(): void {
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send

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
    this.__simpleTranslatorCaptionUrl = String(url)

    if (async === undefined) {
      Reflect.apply(originalOpen, this, [method, url])
      return
    }

    Reflect.apply(originalOpen, this, [method, url, async, username, password])
  }

  XMLHttpRequest.prototype.open = patchedOpen

  XMLHttpRequest.prototype.send = function patchedSend(
    ...args: Parameters<XMLHttpRequest['send']>
  ): void {
    const url = this.__simpleTranslatorCaptionUrl

    if (url && isTimedTextUrl(url)) {
      this.addEventListener('readystatechange', () => {
        if (this.readyState === 4 && this.status === 200 && this.responseText) {
          dispatchCaptionCapture({ url, responseText: this.responseText })
        }
      })
    }

    originalSend.apply(this, args)
  }
}

function installFetchCapture(): void {
  const originalFetch = window.fetch

  async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const response = await originalFetch(input, init)
    const url = getFetchUrl(input)

    if (!isTimedTextUrl(url)) {
      return response
    }

    void response
      .clone()
      .text()
      .then((responseText) => {
        if (responseText) dispatchCaptionCapture({ url, responseText })
      })

    return response
  }

  window.fetch = Object.assign(patchedFetch, originalFetch)
}

function installCaptionRequestHandler(): void {
  window.addEventListener(CAPTION_REQUEST_EVENT, () => {
    // Intentionally no active fetch. YouTube timedtext often returns empty body
    // unless request originates from player with its playback tokens.
  })

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const data = event.data as { source?: string; type?: string }
    if (data.source === 'simple-translator' && data.type === CAPTION_REQUEST_EVENT) {
      // Intentionally no active fetch. Isolated world will force CC reload instead.
    }
  })
}

function installCaptionAvailabilityHandler(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const data = event.data as { requestId?: string; source?: string; type?: string }
    if (data.source !== 'simple-translator' || data.type !== CAPTION_AVAILABILITY_REQUEST_EVENT)
      return

    try {
      const response = readPlayerResponse()
      const captionTracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      window.postMessage(
        {
          source: 'simple-translator',
          type: CAPTION_AVAILABILITY_RESPONSE_EVENT,
          requestId: data.requestId,
          hasPlayerResponse: Boolean(response),
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

declare global {
  interface XMLHttpRequest {
    __simpleTranslatorCaptionUrl?: string
  }
}
