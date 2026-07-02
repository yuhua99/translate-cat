export interface TranslationWindow {
  id: string
  startMs: number
  endMs: number
}

export interface SchedulerState {
  inFlightWindows: ReadonlySet<string>
  completedWindows: ReadonlySet<string>
  ccEnabled: boolean
}

export interface ScheduleInput extends SchedulerState {
  currentTimeMs: number
}

const WINDOW_SIZE_MS = 30_000
const LOOKAHEAD_WINDOWS = 2
const MAX_PLANNED_WINDOWS = 2

export function planTranslationWindows(input: ScheduleInput): TranslationWindow[] {
  if (!input.ccEnabled) return []

  const currentStartMs = windowStart(input.currentTimeMs)
  const windows: TranslationWindow[] = []

  for (let offset = 0; offset <= LOOKAHEAD_WINDOWS; offset += 1) {
    windows.push(createWindow(currentStartMs + offset * WINDOW_SIZE_MS))
  }

  return dedupePlannedWindows(windows, input).slice(0, MAX_PLANNED_WINDOWS)
}

function windowStart(timeMs: number): number {
  return Math.floor(Math.max(0, timeMs) / WINDOW_SIZE_MS) * WINDOW_SIZE_MS
}

function createWindow(startMs: number): TranslationWindow {
  const endMs = startMs + WINDOW_SIZE_MS
  return { id: `${startMs}-${endMs}`, startMs, endMs }
}

function dedupePlannedWindows(
  windows: TranslationWindow[],
  state: SchedulerState,
): TranslationWindow[] {
  const seen = new Set<string>()

  return windows.filter((window) => {
    if (
      window.endMs <= window.startMs ||
      seen.has(window.id) ||
      state.completedWindows.has(window.id) ||
      state.inFlightWindows.has(window.id)
    ) {
      return false
    }

    seen.add(window.id)
    return true
  })
}
