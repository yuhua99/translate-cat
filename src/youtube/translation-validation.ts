export interface ManualTranslationItem {
  id: string
  text: string
}

export function validateManualTranslations(
  requestedIds: readonly string[],
  translations: readonly ManualTranslationItem[],
): ManualTranslationItem[] {
  const requested = new Set(requestedIds)
  const seen = new Set<string>()
  const valid: ManualTranslationItem[] = []

  for (const item of translations) {
    if (typeof item.text !== 'string' || !requested.has(item.id) || seen.has(item.id)) {
      continue
    }

    seen.add(item.id)
    valid.push(item)
  }

  return valid
}

export function missingManualTranslationIds(
  requestedIds: readonly string[],
  translations: readonly ManualTranslationItem[],
): string[] {
  const translated = new Set(
    validateManualTranslations(requestedIds, translations).map((item) => item.id),
  )
  return requestedIds.filter((id) => !translated.has(id))
}
