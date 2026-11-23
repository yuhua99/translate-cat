import {
  CAPTION_AVAILABILITY_REQUEST_EVENT,
  CAPTION_AVAILABILITY_RESPONSE_EVENT,
} from './caption-capture-event'
import { parseYouTubeVideoId } from './video-load'

const CAPTION_AVAILABILITY_TIMEOUT_MS = 1_000
const AVAILABILITY_RECHECK_DELAY_MS = 500
const AVAILABILITY_MAX_RECHECKS = 20

interface CaptionAvailabilityResponse {
  error?: string
  hasCaptionTracks?: boolean
  hasClosedCaptions?: boolean
  hasPlayerResponse?: boolean
  requestId?: string
  source?: string
  type?: string
}

export function findCaptionButton(): HTMLButtonElement | null {
  return document.querySelector('.ytp-subtitles-button')
}

export type CaptionAvailability = 'available' | 'unavailable' | 'not-ready'
let pendingAvailability: { videoId: string; result: Promise<CaptionAvailability> } | undefined

export function waitForCaptionAvailability(): Promise<CaptionAvailability> {
  const videoId = currentVideoId()
  if (!videoId) return Promise.resolve('unavailable')
  if (pendingAvailability?.videoId === videoId) return pendingAvailability.result

  const result = pollCaptionAvailability(videoId).finally(() => {
    if (pendingAvailability?.result === result) pendingAvailability = undefined
  })
  pendingAvailability = { videoId, result }
  return result
}

function currentVideoId(): string | null {
  return parseYouTubeVideoId(new URL(location.href))
}

async function pollCaptionAvailability(videoId: string): Promise<CaptionAvailability> {
  for (let attempt = 0; attempt <= AVAILABILITY_MAX_RECHECKS; attempt++) {
    if (currentVideoId() !== videoId) return 'not-ready'
    const availability = await getCaptionAvailability().catch(() => 'not-ready' as const)
    if (currentVideoId() !== videoId) return 'not-ready'
    if (availability !== 'not-ready') return availability
    if (attempt < AVAILABILITY_MAX_RECHECKS) {
      await new Promise<void>((resolve) =>
        window.setTimeout(resolve, AVAILABILITY_RECHECK_DELAY_MS),
      )
    }
  }
  return 'unavailable'
}

export async function getCaptionAvailability(
  button = findCaptionButton(),
): Promise<CaptionAvailability> {
  if (!button) return 'not-ready'

  let response
  try {
    response = await requestCaptionAvailability()
  } catch (error) {
    console.warn('Caption availability request failed, retrying', error)
    response = await requestCaptionAvailability()
  }

  if (!response.hasPlayerResponse || !response.hasCaptionTracks) return 'not-ready'
  return response.hasClosedCaptions ? 'available' : 'unavailable'
}

function requestCaptionAvailability(): Promise<
  Required<
    Pick<
      CaptionAvailabilityResponse,
      'hasCaptionTracks' | 'hasClosedCaptions' | 'hasPlayerResponse'
    >
  >
> {
  const requestId = crypto.randomUUID()

  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      window.removeEventListener('message', handleMessage)
      reject(new Error('Timed out while reading YouTube caption availability from main world'))
    }, CAPTION_AVAILABILITY_TIMEOUT_MS)

    function handleMessage(event: MessageEvent): void {
      if (event.source !== window) return

      const data = event.data as CaptionAvailabilityResponse
      if (
        data.source !== 'simple-translator' ||
        data.type !== CAPTION_AVAILABILITY_RESPONSE_EVENT ||
        data.requestId !== requestId
      ) {
        return
      }

      window.clearTimeout(timeoutId)
      window.removeEventListener('message', handleMessage)

      if (data.error) {
        reject(new Error(`YouTube getPlayerResponse() failed in main world: ${data.error}`))
        return
      }

      resolve({
        hasCaptionTracks: data.hasCaptionTracks === true,
        hasClosedCaptions: data.hasClosedCaptions === true,
        hasPlayerResponse: data.hasPlayerResponse === true,
      })
    }

    window.addEventListener('message', handleMessage)
    window.postMessage(
      {
        source: 'simple-translator',
        type: CAPTION_AVAILABILITY_REQUEST_EVENT,
        requestId,
      },
      '*',
    )
  })
}
