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

const STYLE = `
#${ROOT_ID} {
  --tc-bg: #111827;
  --tc-surface: #0f172a;
  --tc-fg: #f4f4f5;
  --tc-fg-muted: #cbd5e1;
  --tc-fg-subtle: #94a3b8;
  --tc-border: #1f2937;
  --tc-accent: #3b82f6;
  --tc-radius: 10px;
  --tc-radius-md: 8px;
  --tc-radius-sm: 6px;
  --tc-font: 13px/1.4 system-ui, sans-serif;
  --tc-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  --tc-error: #f87171;
  position: fixed;
  z-index: ${Z};
  font: var(--tc-font);
  color: var(--tc-fg);
}
#${ROOT_ID} .tc-trigger {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
  display: block;
  width: 24px;
  height: 24px;
  background: transparent;
  border: 0;
  padding: 0;
}
#${ROOT_ID} .tc-trigger img {
  width: 24px;
  height: 24px;
  display: block;
  pointer-events: none;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.45));
}
#${ROOT_ID} .tc-bubble {
  background: var(--tc-bg);
  border: 1px solid var(--tc-border);
  border-radius: var(--tc-radius);
  box-shadow: var(--tc-shadow);
  max-width: 360px;
  overflow: hidden;
}
#${ROOT_ID} .tc-handle {
  height: 10px;
  background: var(--tc-surface);
  border-bottom: 1px solid var(--tc-border);
  border-top-left-radius: var(--tc-radius);
  border-top-right-radius: var(--tc-radius);
  cursor: move;
  user-select: none;
  touch-action: none;
}
#${ROOT_ID} .tc-body {
  padding: 10px 12px;
  max-height: 40vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
  color: var(--tc-fg);
}
#${ROOT_ID} .tc-body.tc-error {
  color: var(--tc-error);
}
`

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

const ICON_SIZE = 24
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
  const img = document.createElement('img')
  img.src = chrome.runtime.getURL('icons/icon-32.png')
  img.alt = ''
  btn.appendChild(img)
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

function renderBubble(x: number, y: number, content: string, isError: boolean): void {
  dismiss()
  const pos = clampPosition(x, y, BUBBLE_WIDTH)
  root = makeRoot(pos.x, pos.y)
  const bubble = document.createElement('div')
  bubble.className = 'tc-bubble'
  const handle = document.createElement('div')
  handle.className = 'tc-handle'
  handle.setAttribute('aria-label', 'Drag')
  const body = document.createElement('div')
  body.className = isError ? 'tc-body tc-error' : 'tc-body'
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
  renderBubble(x, y, 'Translating…', false)
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

function getSelectionRect(selection: Selection): DOMRect | null {
  if (selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return rect
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
  const rect = getSelectionRect(selection)
  if (!rect) {
    dismiss()
    return
  }
  const x = rect.right + 4
  const y = rect.bottom + 4
  renderIcon(x, y, text)
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
  window.addEventListener('scroll', onScrollOrResize, true)
  window.addEventListener('resize', onScrollOrResize, true)
}

void main()
