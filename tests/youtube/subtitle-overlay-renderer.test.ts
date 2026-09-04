import { afterEach, describe, expect, test } from 'bun:test'
import { SubtitleOverlayRenderer, findActiveCue } from '../../src/youtube/subtitle-overlay-renderer'
import type { TranslatedCue } from '../../src/youtube/caption-types'

function cue(id: string, startMs: number, endMs: number): TranslatedCue {
  return { id, startMs, endMs, translatedText: id }
}

const originalDocument = globalThis.document
const originalResizeObserver = globalThis.ResizeObserver

class MockResizeObserver {
  static instances: MockResizeObserver[] = []

  readonly observed: Element[] = []
  disconnectCount = 0

  constructor() {
    MockResizeObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.observed.push(target)
  }

  disconnect(): void {
    this.disconnectCount += 1
  }
}

interface MockOverlay {
  id: string
  textContent: string
  hidden: boolean
  style: CSSStyleDeclaration
  remove(): void
}

interface OverlayDomMock {
  readonly overlay: MockOverlay
  removeOverlay(): void
  setVideo(video: HTMLVideoElement | null): void
}

afterEach(() => {
  if (originalDocument === undefined) {
    Reflect.deleteProperty(globalThis, 'document')
  } else {
    globalThis.document = originalDocument
  }

  if (originalResizeObserver === undefined) {
    Reflect.deleteProperty(globalThis, 'ResizeObserver')
  } else {
    globalThis.ResizeObserver = originalResizeObserver
  }
})

describe('findActiveCue', () => {
  test('clamps cue end at next cue start', () => {
    const cues = [cue('a', 0, 3000), cue('b', 2000, 4000)]

    expect(findActiveCue(cues, 1999)?.id).toBe('a')
    expect(findActiveCue(cues, 2000)?.id).toBe('b')
  })
})

describe('SubtitleOverlayRenderer', () => {
  test('does not recreate the observer for identical video and overlay', () => {
    installDomMock(createVideo(100))
    const renderer = new SubtitleOverlayRenderer()

    renderer.render([], 0)
    renderer.render([], 0)

    expect(MockResizeObserver.instances).toHaveLength(1)
    expect(MockResizeObserver.instances[0]?.disconnectCount).toBe(0)
  })

  test('rebinds the observer and updates the font size when the video changes', () => {
    const dom = installDomMock(createVideo(100))
    const renderer = new SubtitleOverlayRenderer()

    renderer.render([], 0)
    const oldObserver = MockResizeObserver.instances[0]
    const replacementVideo = createVideo(200)
    dom.setVideo(replacementVideo)
    renderer.render([], 0)

    expect(oldObserver?.disconnectCount).toBe(1)
    expect(MockResizeObserver.instances).toHaveLength(2)
    expect(MockResizeObserver.instances[1]?.observed).toEqual([replacementVideo])
    expect(dom.overlay.style.fontSize).toBe('9px')
  })

  test('rebinds the observer when a removed overlay is recreated', () => {
    const video = createVideo(100)
    const dom = installDomMock(video)
    const renderer = new SubtitleOverlayRenderer()

    renderer.render([], 0)
    const oldObserver = MockResizeObserver.instances[0]
    dom.removeOverlay()
    renderer.render([], 0)

    expect(oldObserver?.disconnectCount).toBe(1)
    expect(MockResizeObserver.instances).toHaveLength(2)
    expect(MockResizeObserver.instances[1]?.observed).toEqual([video])
  })

  test('clear removes the overlay and disconnects the observer once', () => {
    const dom = installDomMock(createVideo(100))
    const renderer = new SubtitleOverlayRenderer()

    renderer.render([], 0)
    const observer = MockResizeObserver.instances[0]
    renderer.clear()

    expect(() => dom.overlay).toThrow('Overlay is not mounted')
    expect(observer?.disconnectCount).toBe(1)

    renderer.clear()

    expect(observer?.disconnectCount).toBe(1)
  })
})

function createVideo(offsetHeight: number): HTMLVideoElement {
  return { offsetHeight } as HTMLVideoElement
}

function installDomMock(video: HTMLVideoElement | null): OverlayDomMock {
  let activeOverlay: MockOverlay | null = null
  let currentVideo = video
  const player = {
    append(node: Node): void {
      activeOverlay = node as unknown as MockOverlay
    },
  } as unknown as HTMLElement

  globalThis.document = {
    body: player,
    createElement: () => {
      let overlay: MockOverlay
      overlay = {
        id: '',
        textContent: '',
        hidden: false,
        style: {} as CSSStyleDeclaration,
        remove: () => {
          if (activeOverlay === overlay) activeOverlay = null
        },
      }
      return overlay as unknown as HTMLElement
    },
    getElementById: (id: string) =>
      activeOverlay?.id === id ? (activeOverlay as unknown as HTMLElement) : null,
    querySelector: (selector: string) => {
      if (selector === 'video') return currentVideo
      return selector === '#movie_player' ? player : null
    },
  } as unknown as Document
  MockResizeObserver.instances = []
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver

  return {
    get overlay(): MockOverlay {
      if (!activeOverlay) throw new Error('Overlay is not mounted')
      return activeOverlay
    },
    removeOverlay(): void {
      activeOverlay = null
    },
    setVideo(nextVideo: HTMLVideoElement | null): void {
      currentVideo = nextVideo
    },
  }
}
