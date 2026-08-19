import type { CaptionSegment } from './caption-types'

const GAP_BREAK_MS = 700
const MAX_CHARS = 120
const DURATION_BREAK_MS = 6_000
const SENTENCE_END = /[.?!。！？]$/
const FALLBACK_END_MS = 1_500

export function mergeAsrSegments(segments: readonly CaptionSegment[]): CaptionSegment[] {
  if (segments.length === 0) return []

  const groups: Array<CaptionSegment[]> = []
  let current: CaptionSegment[] = []

  for (const segment of segments) {
    const first = current[0]

    if (first) {
      const gap = segment.startMs - (current[current.length - 1]?.startMs ?? first.startMs)
      const duration = segment.startMs - first.startMs
      const accumulatedChars = current.reduce((sum, s) => sum + s.text.length, 0)

      if (
        gap > GAP_BREAK_MS ||
        accumulatedChars + segment.text.length > MAX_CHARS ||
        SENTENCE_END.test(current[current.length - 1]?.text ?? '') ||
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

  const text = group
    .map((s) => s.text)
    .join('')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const sourceIds = group.map((s) => s.id).join(',')
  const nextStartMs = nextGroup?.[0]?.startMs

  return {
    id: `${first.id}:merged:${index}:${hashSourceIds(sourceIds)}`,
    startMs: first.startMs,
    endMs: nextStartMs ?? last.endMs ?? last.startMs + FALLBACK_END_MS,
    text,
  }
}

function hashSourceIds(input: string): string {
  let hash = 0
  for (let i = 0; i < input.length; i += 1) {
    hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}
