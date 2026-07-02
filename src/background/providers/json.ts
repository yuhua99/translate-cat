import { ProviderJsonParseError } from './errors'

export function parseJsonObject<T>(text: string): T {
  const trimmed = text.trim()

  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as T
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed)
  if (fenced?.[1]) {
    return JSON.parse(fenced[1]) as T
  }

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')

  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as T
  }

  throw new ProviderJsonParseError('Provider response did not contain JSON object')
}
