export const CAPTION_EVENT = 'simple-translator-yt-captions'
export const CAPTION_REQUEST_EVENT = 'simple-translator-request-yt-captions'
export const CAPTION_AVAILABILITY_REQUEST_EVENT = 'simple-translator-request-caption-availability'
export const CAPTION_AVAILABILITY_RESPONSE_EVENT = 'simple-translator-caption-availability'

export interface CaptionsCapturedEventDetail {
  url: string
  responseText: string
}

export function isTimedTextUrl(url: string): boolean {
  return url.includes('/api/timedtext')
}
