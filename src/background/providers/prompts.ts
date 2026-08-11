import type { ManualTranslateInput } from './types'

export function createManualSystemPrompt(input: ManualTranslateInput): string {
  if (input.mode === 'selection') {
    return 'You are a translation engine. Return valid JSON only.'
  }
  if (input.mode === 'dictionary') {
    return 'You are a concise bilingual dictionary. Return valid JSON only.'
  }
  return 'You are a subtitle translation engine. Return valid JSON only.'
}

export function createManualPrompt(input: ManualTranslateInput): string {
  if (input.mode === 'selection') {
    return [
      `Translate the selected text to ${input.targetLanguage}.`,
      'Return JSON only in this shape: {"translations":[{"id":"segment-id","text":"translation"}]}',
      'Preserve meaning. Do not add explanations.',
      JSON.stringify({ items: input.items }),
    ].join('\n\n')
  }

  if (input.mode === 'dictionary') {
    return [
      `Explain the word like a dictionary for a learner, in ${input.targetLanguage}.`,
      'Include pronunciation or reading if useful, parts of speech, core meanings, and 1-2 short example sentences with translations when needed.',
      'Put the entire explanation as plain text in translations[].text.',
      'Return JSON only in this shape: {"translations":[{"id":"segment-id","text":"translation"}]}. No markdown fences or extra keys.',
      JSON.stringify({ items: input.items }),
    ].join('\n\n')
  }

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
