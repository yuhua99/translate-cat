import {
  DEFAULT_SETTINGS,
  watchSettings,
  type ExtensionMessage,
  type ExtensionResponse,
  type ExtensionSettings,
  type SettingsResponse,
  type TranslateTextResponse,
} from '../shared/messages'

const ROOT_ID = 'translate-cat-selection-root'
const STYLE_ID = 'translate-cat-selection-style'
const MAX_LEN = 2000
const Z = 2147483647

// Mirror public/lcd.css type tokens; this stylesheet is injected into host pages.
const STYLE = `
#${ROOT_ID},
#${ROOT_ID} * {
  box-sizing: border-box;
}
#${ROOT_ID} {
  --tc-screen: #a8b39a;
  --tc-ink: #1e241c;
  --tc-bezel: #2a2a28;
  --lcd-font: ui-monospace, 'SF Mono', Consolas, monospace;
  --lcd-size-read: 13px;
  position: fixed;
  z-index: ${Z};
  color: var(--tc-ink);
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
  color: var(--tc-ink);
  cursor: pointer;
  font: 700 var(--lcd-size-read)/1 var(--lcd-font);
}
#${ROOT_ID} .tc-trigger svg {
  display: block;
  width: 28px;
  height: 28px;
  pointer-events: none;
  shape-rendering: crispEdges;
}
#${ROOT_ID} .tc-bubble {
  max-width: 360px;
  overflow: hidden;
  color: var(--tc-ink);
  background-color: var(--tc-screen);
  background-image: repeating-linear-gradient(90deg, rgba(30, 36, 28, 0.06) 0 1px, transparent 1px 4px);
  border: 1px solid var(--tc-ink);
  border-radius: 2px;
  font: 700 var(--lcd-size-read)/1.45 var(--lcd-font);
}
#${ROOT_ID} .tc-handle {
  height: 8px;
  border-bottom: 1px dotted var(--tc-ink);
  background-image: radial-gradient(circle, var(--tc-ink) 1px, transparent 1.25px);
  background-position: center;
  background-size: 4px 4px;
  cursor: move;
  touch-action: none;
  user-select: none;
}
#${ROOT_ID} .tc-body {
  max-height: 40vh;
  padding: 10px 12px;
  overflow: auto;
  color: var(--tc-ink);
  font: 700 var(--lcd-size-read)/1.45 var(--lcd-font);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
#${ROOT_ID} .tc-body.tc-loading::after {
  display: inline-block;
  margin-left: 4px;
  content: '█';
  animation: tc-cursor-blink 1s steps(1, end) infinite;
}
#${ROOT_ID} .tc-body.tc-error {
  color: var(--tc-screen);
  background: var(--tc-ink);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
@keyframes tc-cursor-blink {
  50% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  #${ROOT_ID} .tc-body.tc-loading::after { animation: none; }
}
`

const PIXEL_LOGO = `<svg viewBox="0 0 16 16" aria-hidden="true" shape-rendering="crispEdges"><rect x="1" width="14" height="1" fill="#1e241c"/><rect y="1" width="16" height="14" fill="#1e241c"/><rect x="1" y="15" width="14" height="1" fill="#1e241c"/><g fill="#d1d5ca"><rect x="3" y="6" width="2" height="2"/><rect x="11" y="6" width="2" height="2"/><rect x="2" y="8" width="12" height="7"/><rect x="1" y="11" width="14" height="3"/></g><g fill="#1e241c"><rect x="3" y="10" width="3" height="1"/><rect x="10" y="10" width="3" height="1"/><rect x="4" y="11" width="2" height="1"/><rect x="10" y="11" width="2" height="1"/><rect x="7" y="12" width="2" height="1"/><rect x="1" y="12" width="2" height="1"/><rect x="13" y="12" width="2" height="1"/><rect x="1" y="14" width="3" height="1"/><rect x="12" y="14" width="3" height="1"/></g></svg>`

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
let showingIcon = false
let enabled = false
let contextMenuSelection: { x: number; y: number; text: string; oversized: boolean } | null = null

function isInsideRoot(node: Node | null): boolean {
  if (!node) return false
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return !!el && !!el.closest(`#${ROOT_ID}`)
}

function dismiss(): void {
  root?.remove()
  root = null
  bubbleBody = null
  showingIcon = false
}

const ICON_SIZE = 28
const BUBBLE_WIDTH = 368
const EDGE_MARGIN = 8

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

function clampPosition(x: number, y: number, width: number): { x: number; y: number } {
  const maxX = window.innerWidth - width - EDGE_MARGIN
  const maxY = window.innerHeight - EDGE_MARGIN
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
  const pos = clampPosition(x, y, ICON_SIZE)
  root = makeRoot(pos.x, pos.y)
  showingIcon = true
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'tc-trigger'
  btn.setAttribute('aria-label', 'Translate selection')
  btn.innerHTML = PIXEL_LOGO
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    void translate(x, y, text)
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
  const pos = clampPosition(x, y, BUBBLE_WIDTH)
  root = makeRoot(pos.x, pos.y)
  const bubble = document.createElement('div')
  bubble.className = 'tc-bubble'
  const handle = document.createElement('div')
  handle.className = 'tc-handle'
  handle.setAttribute('aria-label', 'Drag')
  const body = document.createElement('div')
  body.className = isError ? 'tc-body tc-error' : isLoading ? 'tc-body tc-loading' : 'tc-body'
  body.textContent = content
  bubble.appendChild(handle)
  bubble.appendChild(body)
  root.appendChild(bubble)
  bubbleBody = body
  document.body.appendChild(root)
  attachDrag(handle)
}

function updateBubble(content: string, isError: boolean): void {
  if (!bubbleBody) return
  bubbleBody.className = isError ? 'tc-body tc-error' : 'tc-body'
  bubbleBody.textContent = content
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

async function translate(x: number, y: number, text: string): Promise<void> {
  renderBubble(x, y, 'TRANSLATING', false, true)
  const token = root
  try {
    const response = await sendMessage<TranslateTextResponse>({
      type: 'TRANSLATE_TEXT',
      text,
    })
    if (root !== token) return
    if (response.ok) {
      updateBubble(response.translation, false)
    } else {
      updateBubble(response.error, true)
    }
  } catch (err) {
    if (root !== token) return
    updateBubble(err instanceof Error ? err.message : String(err), true)
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
    renderBubble(contextMenuSelection.x, contextMenuSelection.y, 'Selection too long', true)
    return
  }
  void translate(contextMenuSelection.x, contextMenuSelection.y, contextMenuSelection.text)
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
  subscribeToSettings()
  document.addEventListener('mouseup', onMouseUp, true)
  document.addEventListener('mousedown', onMouseDown, true)
  document.addEventListener('contextmenu', onContextMenu, true)
  chrome.runtime.onMessage.addListener(onContextMenuTranslate)
  window.addEventListener('scroll', onScrollOrResize, true)
  window.addEventListener('resize', onScrollOrResize, true)
}

void main()
