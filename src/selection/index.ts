import {
  DEFAULT_SETTINGS,
  watchSettings,
  type ExtensionMessage,
  type ExtensionResponse,
  type ExtensionSettings,
  type SettingsResponse,
} from '../shared/messages'
import { createSelectionStreamingClient, type SelectionTranslationHandle } from './streaming-client'

const ROOT_ID = 'translate-cat-selection-root'
const STYLE_ID = 'translate-cat-selection-style'
const MAX_LEN = 2000
const Z = 2147483647

// Mirror public/lcd.css tokens used by this injected host-page stylesheet.
const STYLE = `
#${ROOT_ID},
#${ROOT_ID} * {
  box-sizing: border-box;
}
#${ROOT_ID} {
  --lcd-screen: #a8b39a;
  --lcd-ink: #1e241c;
  --lcd-bezel-ink: #d1d5ca;
  --lcd-grid: rgb(30 36 28 / 6%);
  --lcd-space: 4px;
  --lcd-hairline: 2px;
  --lcd-font: ui-monospace, 'SF Mono', Consolas, monospace;
  --lcd-size-ui: 12px;
  --lcd-size-meta: 11px;
  --lcd-size-read: 13px;
  position: fixed;
  z-index: ${Z};
  color: var(--lcd-ink);
  font-family: var(--lcd-font);
  font-size: var(--lcd-size-read);
  font-weight: 700;
  line-height: 1.45;
}
#${ROOT_ID} .tc-trigger {
  all: unset;
  box-sizing: border-box;
  display: block;
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--lcd-ink);
  cursor: pointer;
  font: 700 var(--lcd-size-read)/1 var(--lcd-font);
}
#${ROOT_ID} .tc-trigger:focus-visible {
  outline: var(--lcd-hairline) solid var(--lcd-ink);
  outline-offset: 1px;
}
#${ROOT_ID} .tc-trigger svg {
  display: block;
  width: 28px;
  height: 28px;
  pointer-events: none;
  shape-rendering: crispEdges;
}
#${ROOT_ID} .tc-logo__ink {
  fill: var(--lcd-ink);
}
#${ROOT_ID} .tc-logo__face {
  fill: var(--lcd-bezel-ink);
}
/* Keep max-width in sync with BUBBLE_MAX_WIDTH. */
#${ROOT_ID} .tc-bubble {
  max-width: 360px;
  overflow: hidden;
  color: var(--lcd-ink);
  background-color: var(--lcd-screen);
  background-image: repeating-linear-gradient(90deg, var(--lcd-grid) 0 1px, transparent 1px 4px);
  border: var(--lcd-hairline) solid var(--lcd-ink);
  font: 700 var(--lcd-size-read)/1.45 var(--lcd-font);
}
#${ROOT_ID} .tc-titlebar {
  display: flex;
  align-items: center;
  min-height: 24px;
  padding: 0 calc(var(--lcd-space) * 1.5);
  border-bottom: var(--lcd-hairline) solid var(--lcd-ink);
  cursor: move;
  font: 700 var(--lcd-size-ui)/1 var(--lcd-font);
  letter-spacing: 0.08em;
  touch-action: none;
  user-select: none;
}
#${ROOT_ID} .tc-titlebar:hover {
  color: var(--lcd-screen);
  background-color: var(--lcd-ink);
}
#${ROOT_ID} .tc-titlebar__logo {
  display: block;
  margin-right: 6px;
}
#${ROOT_ID} .tc-titlebar__logo svg {
  display: block;
  width: 18px;
  height: 18px;
  pointer-events: none;
  shape-rendering: crispEdges;
}
#${ROOT_ID} .tc-titlebar .tc-logo__face {
  fill: var(--lcd-screen);
}
#${ROOT_ID} .tc-titlebar:hover .tc-logo__ink {
  fill: var(--lcd-screen);
}
#${ROOT_ID} .tc-titlebar:hover .tc-logo__face {
  fill: var(--lcd-ink);
}
#${ROOT_ID} .tc-body {
  max-height: 40vh;
  padding: calc(var(--lcd-space) * 2) calc(var(--lcd-space) * 3);
  overflow: auto;
  color: var(--lcd-ink);
  font: 700 var(--lcd-size-read)/1.45 var(--lcd-font);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
#${ROOT_ID} .tc-body::-webkit-scrollbar {
  width: 8px;
}
#${ROOT_ID} .tc-body::-webkit-scrollbar-track {
  background: var(--lcd-screen);
}
#${ROOT_ID} .tc-body::-webkit-scrollbar-thumb {
  background: var(--lcd-ink);
  border: 2px solid var(--lcd-screen);
}
#${ROOT_ID} .tc-body.tc-loading::after {
  display: inline-block;
  margin-left: 4px;
  content: '█';
  animation: tc-cursor-blink 1s steps(1, end) infinite;
}
#${ROOT_ID} .tc-body.tc-error {
  color: var(--lcd-screen);
  background: var(--lcd-ink);
  font-size: var(--lcd-size-meta);
  line-height: 1.25;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
#${ROOT_ID} .tc-body.tc-error::selection {
  color: var(--lcd-ink);
  background: var(--lcd-screen);
}
@keyframes tc-cursor-blink {
  50% { opacity: 0; }
}
`

const PIXEL_LOGO = `<svg viewBox="0 0 16 16" aria-hidden="true" shape-rendering="crispEdges"><g class="tc-logo__ink"><rect x="1" width="14" height="1"/><rect y="1" width="16" height="14"/><rect x="1" y="15" width="14" height="1"/></g><g class="tc-logo__face"><rect x="3" y="6" width="2" height="2"/><rect x="11" y="6" width="2" height="2"/><rect x="2" y="8" width="12" height="7"/><rect x="1" y="11" width="14" height="3"/></g><g class="tc-logo__ink"><rect x="3" y="10" width="3" height="1"/><rect x="10" y="10" width="3" height="1"/><rect x="4" y="11" width="2" height="1"/><rect x="10" y="11" width="2" height="1"/><rect x="7" y="12" width="2" height="1"/><rect x="1" y="12" width="2" height="1"/><rect x="13" y="12" width="2" height="1"/><rect x="1" y="14" width="3" height="1"/><rect x="12" y="14" width="3" height="1"/></g></svg>`

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE
  ;(document.head ?? document.documentElement).appendChild(style)
}

function sendMessage<TResponse extends ExtensionResponse>(
  message: ExtensionMessage,
): Promise<TResponse> {
  return chrome.runtime.sendMessage(message)
}

async function loadSettings(): Promise<ExtensionSettings> {
  try {
    const response = await sendMessage<SettingsResponse>({ type: 'GET_SETTINGS' })
    if (response.ok) return response.settings
    return { ...DEFAULT_SETTINGS, selectionEnabled: false }
  } catch {
    return { ...DEFAULT_SETTINGS, selectionEnabled: false }
  }
}

let root: HTMLDivElement | null = null
let bubbleBody: HTMLDivElement | null = null
let bubbleText: Text | null = null
let showingIcon = false
let enabled = false
let targetLanguage = DEFAULT_SETTINGS.targetLanguage
let activeTranslation: SelectionTranslationHandle | null = null
let contextMenuSelection: { x: number; y: number; text: string; oversized: boolean } | null = null

function isInsideRoot(node: Node | null): boolean {
  if (!node) return false
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return !!el && !!el.closest(`#${ROOT_ID}`)
}

function cancelActiveTranslation(): void {
  const translation = activeTranslation
  activeTranslation = null
  translation?.cancel()
}

function dismiss(): void {
  cancelActiveTranslation()
  root?.remove()
  root = null
  bubbleBody = null
  bubbleText = null
  showingIcon = false
}

const ICON_SIZE = 28
const EDGE_MARGIN = 8
// Keep in sync with .tc-bubble max-width + border in STYLE.
const BUBBLE_MAX_WIDTH = 364

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

function clampPosition(
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const maxX = window.innerWidth - width - EDGE_MARGIN
  const maxY = window.innerHeight - height - EDGE_MARGIN
  return {
    x: clamp(x, EDGE_MARGIN, maxX),
    y: clamp(y, EDGE_MARGIN, maxY),
  }
}

function makeRoot(x: number, y: number): HTMLDivElement {
  ensureStyle()
  const el = document.createElement('div')
  el.id = ROOT_ID
  el.style.left = `${x}px`
  el.style.top = `${y}px`
  return el
}

function renderIcon(x: number, y: number, text: string): void {
  dismiss()
  const pos = clampPosition(x, y, ICON_SIZE, ICON_SIZE)
  root = makeRoot(pos.x, pos.y)
  showingIcon = true
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'tc-trigger'
  btn.setAttribute('aria-label', chrome.i18n.getMessage('selectionTranslate'))
  btn.innerHTML = PIXEL_LOGO
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    translate(x, y, text)
  })
  root.appendChild(btn)
  document.body.appendChild(root)
}

function renderBubble(
  x: number,
  y: number,
  content: string,
  isError: boolean,
  isLoading = false,
): void {
  dismiss()
  root = makeRoot(0, 0)
  const bubble = document.createElement('div')
  bubble.className = 'tc-bubble'
  const handle = document.createElement('div')
  handle.className = 'tc-titlebar'
  handle.setAttribute('aria-label', chrome.i18n.getMessage('selectionDrag'))
  const logo = document.createElement('span')
  logo.className = 'tc-titlebar__logo'
  logo.innerHTML = PIXEL_LOGO
  const wordmark = document.createElement('span')
  wordmark.textContent = 'TRANSLATE CAT'
  handle.append(logo, wordmark)
  const body = document.createElement('div')
  body.className = isError ? 'tc-body tc-error' : isLoading ? 'tc-body tc-loading' : 'tc-body'
  bubbleText = document.createTextNode(content)
  body.appendChild(bubbleText)
  bubble.appendChild(handle)
  bubble.appendChild(body)
  root.appendChild(bubble)
  bubbleBody = body
  document.body.appendChild(root)
  const bubbleRect = bubble.getBoundingClientRect()
  // Streaming content grows to max-width after measuring, so clamp against the cap.
  const effectiveWidth = isLoading ? BUBBLE_MAX_WIDTH : bubbleRect.width
  const pos = clampPosition(x, y, effectiveWidth, bubbleRect.height)
  root.style.left = `${pos.x}px`
  if (y > window.innerHeight / 2) {
    root.style.top = ''
    root.style.bottom = `${Math.max(window.innerHeight - y, EDGE_MARGIN)}px`
  } else {
    root.style.top = `${pos.y}px`
  }
  attachDrag(handle)
}

function updateBubble(content: string, isError: boolean): void {
  if (!bubbleBody || !bubbleText) return
  bubbleBody.className = isError ? 'tc-body tc-error' : 'tc-body'
  bubbleText.data = content
}

function resetBubble(): void {
  if (!bubbleBody || !bubbleText) return
  bubbleBody.className = 'tc-body tc-loading'
  bubbleText.data = chrome.i18n.getMessage('selectionTranslating')
}

function appendToBubble(content: string, first: boolean): void {
  if (!bubbleBody || !bubbleText) return
  if (first) {
    bubbleBody.className = 'tc-body'
    bubbleText.data = content
    return
  }
  bubbleText.data += content
}

function attachDrag(handle: HTMLElement): void {
  let startX = 0
  let startY = 0
  let startLeft = 0
  let startTop = 0
  handle.addEventListener('pointerdown', (e) => {
    if (!root) return
    e.preventDefault()
    e.stopPropagation()
    if (root.style.bottom) {
      root.style.top = `${root.getBoundingClientRect().top}px`
      root.style.bottom = ''
    }
    startX = e.clientX
    startY = e.clientY
    startLeft = parseFloat(root.style.left) || 0
    startTop = parseFloat(root.style.top) || 0
    handle.setPointerCapture(e.pointerId)
  })
  handle.addEventListener('pointermove', (e) => {
    if (!root) return
    if (!handle.hasPointerCapture(e.pointerId)) return
    root.style.left = `${startLeft + (e.clientX - startX)}px`
    root.style.top = `${startTop + (e.clientY - startY)}px`
  })
  const release = (e: PointerEvent) => {
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId)
  }
  handle.addEventListener('pointerup', release)
  handle.addEventListener('pointercancel', release)
}

function translate(x: number, y: number, text: string): void {
  cancelActiveTranslation()
  renderBubble(x, y, chrome.i18n.getMessage('selectionTranslating'), false, true)
  const token = root
  let receivedDelta = false
  try {
    activeTranslation = createSelectionStreamingClient().translate(
      { text, targetLanguage },
      {
        started: () => {
          if (root !== token) return
          receivedDelta = false
          resetBubble()
        },
        delta: (delta) => {
          if (root !== token) return
          appendToBubble(delta, !receivedDelta)
          receivedDelta = true
        },
        reset: () => {
          if (root !== token) return
          receivedDelta = false
          resetBubble()
        },
        complete: () => {
          if (root !== token) return
          activeTranslation = null
        },
        error: (error) => {
          if (root !== token) return
          activeTranslation = null
          updateBubble(error, true)
        },
        disconnected: () => {
          if (root !== token) return
          activeTranslation = null
          updateBubble(chrome.i18n.getMessage('selectionDisconnected'), true)
        },
      },
    )
  } catch (error) {
    if (root !== token) return
    updateBubble(error instanceof Error ? error.message : String(error), true)
  }
}

function onMouseUp(event: MouseEvent): void {
  if (!enabled) {
    dismiss()
    return
  }
  if (isInsideRoot(event.target as Node)) return
  const selection = window.getSelection()
  if (!selection) {
    dismiss()
    return
  }
  const text = selection.toString().trim()
  if (!text) {
    dismiss()
    return
  }
  if (text.length > MAX_LEN) {
    dismiss()
    return
  }
  if (isInsideRoot(selection.anchorNode) || isInsideRoot(selection.focusNode)) return
  if (!document.body) return
  const x = event.clientX + 4
  const y = event.clientY + 4
  renderIcon(x, y, text)
}

function onContextMenu(event: MouseEvent): void {
  const text = window.getSelection()?.toString().trim()
  if (!text) {
    contextMenuSelection = null
    return
  }
  contextMenuSelection = {
    x: event.clientX,
    y: event.clientY,
    text,
    oversized: text.length > MAX_LEN,
  }
}

function onContextMenuTranslate(message: ExtensionMessage): void {
  if (message.type !== 'CONTEXT_MENU_TRANSLATE' || !contextMenuSelection) return
  if (contextMenuSelection.oversized) {
    renderBubble(
      contextMenuSelection.x,
      contextMenuSelection.y,
      chrome.i18n.getMessage('selectionTooLong'),
      true,
    )
    return
  }
  translate(contextMenuSelection.x, contextMenuSelection.y, contextMenuSelection.text)
}

function onMouseDown(event: MouseEvent): void {
  if (isInsideRoot(event.target as Node)) return
  dismiss()
}

function onScrollOrResize(): void {
  if (showingIcon) dismiss()
}

function subscribeToSettings(): void {
  watchSettings((settings) => {
    enabled = settings.selectionEnabled
    targetLanguage = settings.targetLanguage
    if (!enabled) dismiss()
  })
}

function isTopFrame(): boolean {
  try {
    return window.top === window
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  if (!isTopFrame()) return
  const settings = await loadSettings()
  enabled = settings.selectionEnabled
  targetLanguage = settings.targetLanguage
  subscribeToSettings()
  document.addEventListener('mouseup', onMouseUp, true)
  document.addEventListener('mousedown', onMouseDown, true)
  document.addEventListener('contextmenu', onContextMenu, true)
  chrome.runtime.onMessage.addListener(onContextMenuTranslate)
  window.addEventListener('scroll', onScrollOrResize, true)
  window.addEventListener('resize', onScrollOrResize, true)
}

void main()
