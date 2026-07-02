import type { TranslatedCue } from './caption-types'

const OVERLAY_ID = 'simple-translator-subtitle-overlay'

export function findActiveCue(
  cues: readonly TranslatedCue[],
  currentTimeMs: number,
): TranslatedCue | undefined {
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index]
    if (!cue) continue

    const nextStartMs = cues[index + 1]?.startMs ?? Infinity
    const effectiveEndMs = Math.min(cue.endMs, nextStartMs)
    if (currentTimeMs >= cue.startMs && currentTimeMs < effectiveEndMs) return cue
  }

  return undefined
}

export class SubtitleOverlayRenderer {
  private resizeObserver: ResizeObserver | null = null

  render(cues: readonly TranslatedCue[], currentTimeMs: number): void {
    const cue = findActiveCue(cues, currentTimeMs)
    const overlay = this.ensureOverlay()
    overlay.textContent = cue?.translatedText ?? ''
    overlay.hidden = !cue
  }

  clear(): void {
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    document.getElementById(OVERLAY_ID)?.remove()
  }

  private syncFontSize(overlay: HTMLElement): void {
    const video = document.querySelector<HTMLVideoElement>('video')
    overlay.style.fontSize = video?.offsetHeight
      ? `${Math.round(video.offsetHeight * 0.045)}px`
      : '18px'
  }

  private ensureOverlay(): HTMLElement {
    const existing = document.getElementById(OVERLAY_ID)
    if (existing) return existing

    const overlay = document.createElement('div')
    overlay.id = OVERLAY_ID
    Object.assign(overlay.style, {
      position: 'absolute',
      left: '50%',
      bottom: '10%',
      transform: 'translateX(-50%)',
      zIndex: '60',
      maxWidth: '82%',
      padding: '4px 8px',
      borderRadius: '4px',
      color: 'white',
      background: 'rgba(8, 8, 8, 0.75)',
      lineHeight: '1.35',
      fontFamily: 'system-ui, sans-serif',
      textAlign: 'center',
      whiteSpace: 'pre-wrap',
      pointerEvents: 'none',
    })

    const player = document.querySelector<HTMLElement>('#movie_player') ?? document.body
    player.append(overlay)

    this.syncFontSize(overlay)
    const video = document.querySelector<HTMLVideoElement>('video')
    if (video) {
      this.resizeObserver = new ResizeObserver(() => this.syncFontSize(overlay))
      this.resizeObserver.observe(video)
    }

    return overlay
  }
}

