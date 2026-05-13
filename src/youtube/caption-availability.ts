import {
  CAPTION_AVAILABILITY_REQUEST_EVENT,
  CAPTION_AVAILABILITY_RESPONSE_EVENT,
} from './caption-capture-event'

const CAPTION_AVAILABILITY_TIMEOUT_MS = 1_000

interface CaptionAvailabilityResponse {
  error?: string
  hasClosedCaptions?: boolean
  hasPlayerResponse?: boolean
  requestId?: string
  source?: string
  type?: string
}

export function findCaptionButton(): HTMLButtonElement | null {
  return document.querySelector('.ytp-subtitles-button')
}

export async function hasAvailableCaptions(button = findCaptionButton()): Promise<boolean> {
  if (!button) return false

  const response = await requestCaptionAvailability()
  return response.hasPlayerResponse && response.hasClosedCaptions
}

function requestCaptionAvailability(): Promise<
  Required<Pick<CaptionAvailabilityResponse, 'hasClosedCaptions' | 'hasPlayerResponse'>>
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
