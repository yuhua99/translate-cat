import type { ManualTranslateInput } from './types'

export function createManualPrompt(input: ManualTranslateInput): string {
  const parts: string[] = [
    `Translate subtitles to ${input.targetLanguage}.`,
    'Return JSON only in this shape: {"translations":[{"id":"segment-id","text":"translation"}]}',
    'Preserve meaning. Do not add explanations.',
  ]

  if (input.contextBefore?.length) {
    parts.push(
      'Context before (do NOT translate, for continuity only):',
      JSON.stringify({ contextBefore: input.contextBefore }),
    )
  }

  if (input.contextAfter?.length) {
    parts.push(
      'Context after (do NOT translate, for continuity only):',
      JSON.stringify({ contextAfter: input.contextAfter }),
    )
  }

  parts.push(JSON.stringify({ items: input.items }))
  return parts.join('\n\n')
}
