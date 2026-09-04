import type { CaptionSegment } from './caption-types'

const GAP_BREAK_MS = 700
const MAX_CHARS = 120
const DURATION_BREAK_MS = 6_000
const SENTENCE_END = /[.?!。！？]$/
const ASCII_ALPHANUMERIC = /^[A-Za-z0-9]$/
const FALLBACK_END_MS = 1_500

export function mergeAsrSegments(segments: readonly CaptionSegment[]): CaptionSegment[] {
  if (segments.length === 0) return []

  const groups: Array<CaptionSegment[]> = []
  let current: CaptionSegment[] = []

  for (const segment of segments) {
    const first = current[0]
    const previous = current[current.length - 1]

    if (first && previous) {
      const previousEndMs = previous.endMs ?? previous.startMs
      const gap = segment.startMs - previousEndMs
      const duration = segment.startMs - first.startMs
      const accumulatedText = mergeGroupText(current)
      const separatorLength = needsAsciiAlphanumericSeparator(accumulatedText, segment.text) ? 1 : 0

      if (
        gap > GAP_BREAK_MS ||
        accumulatedText.length + separatorLength + segment.text.length > MAX_CHARS ||
        SENTENCE_END.test(previous.text) ||
        duration > DURATION_BREAK_MS
      ) {
        groups.push(current)
        current = []
      }
    }

    current.push(segment)
  }

  if (current.length > 0) {
    groups.push(current)
  }

  return groups.map((group, index) => createMergedSegment(group, groups[index + 1], index))
}

function createMergedSegment(
  group: readonly CaptionSegment[],
  nextGroup: readonly CaptionSegment[] | undefined,
  index: number,
): CaptionSegment {
  const first = group[0]
  const last = group[group.length - 1]
  if (!first || !last) throw new Error('Cannot merge empty ASR group')

  const text = mergeGroupText(group).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
  const sourceIds = group.map((s) => s.id).join(',')
  const nextStartMs = nextGroup?.[0]?.startMs

  return {
    id: `${first.id}:merged:${index}:${hashSourceIds(sourceIds)}`,
    startMs: first.startMs,
    endMs: nextStartMs ?? last.endMs ?? last.startMs + FALLBACK_END_MS,
    text,
  }
}

function mergeGroupText(group: readonly CaptionSegment[]): string {
  let text = ''

  for (const segment of group) {
    if (needsAsciiAlphanumericSeparator(text, segment.text)) {
      text += ' '
    }

    text += segment.text
  }

  return text
}

function needsAsciiAlphanumericSeparator(previousText: string, nextText: string): boolean {
  const lastCharacter = previousText[previousText.length - 1]
  const firstCharacter = nextText[0]

  return Boolean(
    lastCharacter &&
    firstCharacter &&
    ASCII_ALPHANUMERIC.test(lastCharacter) &&
    ASCII_ALPHANUMERIC.test(firstCharacter),
  )
}

function hashSourceIds(input: string): string {
  let hash = 0
  for (let i = 0; i < input.length; i += 1) {
    hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}
