import type { ManualTranslationItem } from '../youtube/translation-validation'

export interface CacheStorageArea {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

interface CacheState {
  entries: Record<string, CacheEntry>
}

interface CacheEntry {
  createdAt: number
  expiresAt: number
  sizeBytes: number
  translations: ManualTranslationItem[]
}

const CACHE_KEY = 'translationWindowCache'
const TTL_MS = 3 * 24 * 60 * 60 * 1000
const MAX_BYTES = 5 * 1024 * 1024

let writeQueue: Promise<unknown> = Promise.resolve()

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task)
  writeQueue = next.catch(() => undefined)
  return next
}

export async function getCachedTranslations(
  storage: CacheStorageArea,
  key: string,
): Promise<ManualTranslationItem[] | undefined> {
  const state = await readState(storage)
  const entry = state.entries[key]
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) return undefined
  return entry.translations
}

export function setCachedTranslations(
  storage: CacheStorageArea,
  key: string,
  translations: ManualTranslationItem[],
): Promise<void> {
  return enqueueWrite(async () => {
    const state = await readState(storage)
    const now = Date.now()
    const entry: CacheEntry = {
      createdAt: now,
      expiresAt: now + TTL_MS,
      sizeBytes: byteLength(JSON.stringify(translations)),
      translations,
    }

    state.entries[key] = entry
    await writeState(storage, rotate(state))
  })
}

export function clearTranslationCache(storage: CacheStorageArea): Promise<void> {
  return enqueueWrite(async () => {
    await storage.set({ [CACHE_KEY]: { entries: {} } satisfies CacheState })
  })
}

function rotate(state: CacheState): CacheState {
  const now = Date.now()
  for (const [key, entry] of Object.entries(state.entries)) {
    if (entry.expiresAt <= now) delete state.entries[key]
  }

  let total = totalBytes(state)
  if (total <= MAX_BYTES) return state

  const entries = Object.entries(state.entries).sort(([, a], [, b]) => a.createdAt - b.createdAt)
  for (const [key, entry] of entries) {
    delete state.entries[key]
    total -= entry.sizeBytes
    if (total <= MAX_BYTES) break
  }

  return state
}

async function readState(storage: CacheStorageArea): Promise<CacheState> {
  const stored = await storage.get(CACHE_KEY)
  const state = stored[CACHE_KEY] as CacheState | undefined
  return state?.entries ? state : { entries: {} }
}

async function writeState(storage: CacheStorageArea, state: CacheState): Promise<void> {
  await storage.set({ [CACHE_KEY]: state })
}

function totalBytes(state: CacheState): number {
  return Object.values(state.entries).reduce((sum, entry) => sum + entry.sizeBytes, 0)
}

function byteLength(input: string): number {
  return new TextEncoder().encode(input).byteLength
}
