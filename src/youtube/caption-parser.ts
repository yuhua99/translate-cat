import type {
  CaptionMode,
  CaptionSegment,
  CaptionTrack,
  CapturedCaptionResponse,
  ParsedCaptions,
} from './caption-types'

interface Json3Event {
  tStartMs?: number
  dDurationMs?: number
  segs?: Array<{ utf8?: string }>
}

interface Json3Root {
  events?: Json3Event[]
}

export function parseCapturedCaptions(input: CapturedCaptionResponse): ParsedCaptions {
  const track = createTrack(input.url)
  const response = input.responseText.trim()

  if (!response) {
    return { track, segments: [] }
  }

  if (response.startsWith('{')) {
    return { track, segments: parseJson3(response, track) }
  }

  if (response.startsWith('WEBVTT') || response.includes('-->')) {
    return { track, segments: parseVttCaptions(response, track) }
  }

  return { track, segments: parseXmlCaptions(response, track) }
}

function createTrack(url: string): CaptionTrack {
  const parsedUrl = new URL(url, 'https://www.youtube.com')
  const videoId =
    parsedUrl.searchParams.get('v') ?? parsedUrl.searchParams.get('video_id') ?? 'unknown-video'
  const languageCode = parsedUrl.searchParams.get('lang') ?? 'unknown'
  const name = parsedUrl.searchParams.get('name') ?? ''
  const mode: CaptionMode = parsedUrl.searchParams.get('kind') === 'asr' ? 'asr' : 'manual'

  return {
    videoId,
    trackId: `${languageCode}:${name}:${mode}`,
    languageCode,
    mode,
  }
}

function parseJson3(responseText: string, track: CaptionTrack): CaptionSegment[] {
  const root = JSON.parse(responseText) as Json3Root
  const events = root.events ?? []

  return events.flatMap((event, eventIndex) => {
    const text = (event.segs ?? [])
      .map((segment) => segment.utf8 ?? '')
      .join('')
      .trim()

    if (!text || event.tStartMs === undefined) {
      return []
    }

    return [
      createSegment(
        track,
        eventIndex,
        event.tStartMs,
        event.dDurationMs === undefined ? undefined : event.tStartMs + event.dDurationMs,
        text,
      ),
    ]
  })
}

function parseVttCaptions(responseText: string, track: CaptionTrack): CaptionSegment[] {
  const blocks = responseText.replace(/^WEBVTT[^\n]*(?:\n|$)/, '').split(/\n\s*\n/)
  const segments: CaptionSegment[] = []

  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const timeLineIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeLineIndex < 0) continue

    const [startRaw, endRaw] =
      lines[timeLineIndex]?.split('-->').map((part) => part.trim().split(/\s+/)[0]) ?? []
    const startMs = vttTimeToMs(startRaw)
    const endMs = vttTimeToMs(endRaw)
    const text = lines
      .slice(timeLineIndex + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim()

    if (startMs === undefined || endMs === undefined || !text) continue
    segments.push(createSegment(track, segments.length, startMs, endMs, text))
  }

  return segments
}

function parseXmlCaptions(responseText: string, track: CaptionTrack): CaptionSegment[] {
  const segments: CaptionSegment[] = []
  const textTagPattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi
  const pTagPattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi

  for (const match of responseText.matchAll(textTagPattern)) {
    const startMs = secondsToMs(readAttribute(match[1] ?? '', 'start'))
    const durationMs = secondsToMs(readAttribute(match[1] ?? '', 'dur'))
    const text = stripTags(match[2] ?? '').trim()

    if (startMs === undefined || !text) {
      continue
    }

    segments.push(
      createSegment(
        track,
        segments.length,
        startMs,
        durationMs === undefined ? undefined : startMs + durationMs,
        text,
      ),
    )
  }

  if (segments.length > 0) {
    return segments
  }

  for (const match of responseText.matchAll(pTagPattern)) {
    const startMs = ttmlTimeToMs(readAttribute(match[1] ?? '', 'begin'))
    const endMs = ttmlTimeToMs(readAttribute(match[1] ?? '', 'end'))
    const text = stripTags(match[2] ?? '').trim()

    if (startMs === undefined || endMs === undefined || !text) {
      continue
    }

    segments.push(createSegment(track, segments.length, startMs, endMs, text))
  }

  return segments
}

function createSegment(
  track: CaptionTrack,
  index: number,
  startMs: number,
  endMs: number | undefined,
  text: string,
): CaptionSegment {
  const decodedText = decodeHtmlEntities(text).replace(/\\n/g, '\n')

  return {
    id: `${track.videoId}:${track.trackId}:${index}`,
    startMs,
    endMs,
    text: decodedText,
  }
}

function readAttribute(input: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escapedName}=["']([^"']+)["']`, 'i').exec(input)
  return match?.[1]
}

function secondsToMs(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }

  const seconds = Number(value)
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined
}

function vttTimeToMs(value: string | undefined): number | undefined {
  if (!value) return undefined
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(value)
  if (!match) return undefined

  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const millis = Number(match[4])
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis
}

function ttmlTimeToMs(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }

  const clock = /^(?:(\d+):)?(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(value)

  if (clock) {
    const hours = Number(clock[1] ?? 0)
    const minutes = Number(clock[2])
    const seconds = Number(clock[3])
    const fraction = Number(`0.${clock[4] ?? '0'}`)
    return Math.round((hours * 60 * 60 + minutes * 60 + seconds + fraction) * 1000)
  }

  const secondValue = /^(\d+(?:\.\d+)?)s$/.exec(value)
  if (secondValue) {
    return Math.round(Number(secondValue[1]) * 1000)
  }

  return undefined
}

function stripTags(input: string): string {
  return input.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
}

function decodeHtmlEntities(input: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    '#39': "'",
  }

  return input.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, key: string) => {
    if (key.startsWith('#x')) {
      return String.fromCodePoint(Number.parseInt(key.slice(2), 16))
    }

    if (key.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(key.slice(1), 10))
    }

    return named[key.toLowerCase()] ?? entity
  })
}
