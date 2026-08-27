export interface TranslationWindow {
  id: string
  startMs: number
  endMs: number
}

interface SchedulerState {
  inFlightWindows: ReadonlySet<string>
  completedWindows: ReadonlySet<string>
  ccEnabled: boolean
}

interface ScheduleInput extends SchedulerState {
  currentTimeMs: number
}

const WINDOW_SIZE_MS = 30_000
const LOOKAHEAD_WINDOWS = 2
const MAX_PLANNED_WINDOWS = 2

export function windowFor(timeMs: number): TranslationWindow {
  return createWindow(windowStart(timeMs))
}

export function planTranslationWindows(input: ScheduleInput): TranslationWindow[] {
  if (!input.ccEnabled) return []

  const currentStartMs = windowFor(input.currentTimeMs).startMs
  const windows: TranslationWindow[] = []

  for (let offset = 0; offset <= LOOKAHEAD_WINDOWS; offset += 1) {
    windows.push(createWindow(currentStartMs + offset * WINDOW_SIZE_MS))
  }

  return filterPlannedWindows(windows, input).slice(0, MAX_PLANNED_WINDOWS)
}

function windowStart(timeMs: number): number {
  return Math.floor(Math.max(0, timeMs) / WINDOW_SIZE_MS) * WINDOW_SIZE_MS
}

function createWindow(startMs: number): TranslationWindow {
  const endMs = startMs + WINDOW_SIZE_MS
  return { id: `${startMs}-${endMs}`, startMs, endMs }
}

function filterPlannedWindows(
  windows: TranslationWindow[],
  state: SchedulerState,
): TranslationWindow[] {
  return windows.filter(
    (window) =>
      window.endMs > window.startMs &&
      !state.completedWindows.has(window.id) &&
      !state.inFlightWindows.has(window.id),
  )
}
