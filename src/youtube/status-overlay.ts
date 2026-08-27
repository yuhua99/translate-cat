const STATUS_ID = 'simple-translator-status-overlay'
let dismissTimer: number | undefined

export function showStatusOverlay(message: string): void {
  const root = ensureStatusOverlay()
  const text = root.querySelector<HTMLElement>('[data-role="message"]')
  if (text) text.textContent = message
  root.hidden = false

  if (dismissTimer !== undefined) {
    window.clearTimeout(dismissTimer)
  }

  dismissTimer = window.setTimeout(() => {
    root.hidden = true
  }, 3_000)
}

function ensureStatusOverlay(): HTMLElement {
  const existing = document.getElementById(STATUS_ID)
  if (existing) return existing

  const root = document.createElement('div')
  root.id = STATUS_ID
  root.style.position = 'fixed'
  root.style.right = '16px'
  root.style.bottom = '16px'
  root.style.zIndex = '2147483647'
  root.style.display = 'flex'
  root.style.alignItems = 'center'
  root.style.gap = '10px'
  root.style.maxWidth = '360px'
  root.style.padding = '10px 12px'
  root.style.borderRadius = '10px'
  root.style.color = 'white'
  root.style.background = 'rgba(20, 20, 20, 0.92)'
  root.style.boxShadow = '0 8px 24px rgba(0,0,0,.25)'
  root.style.font = '13px/1.4 system-ui, sans-serif'

  const message = document.createElement('span')
  message.dataset.role = 'message'

  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '×'
  close.setAttribute('aria-label', chrome.i18n.getMessage('close'))
  close.style.border = '0'
  close.style.background = 'transparent'
  close.style.color = 'inherit'
  close.style.font = '18px/1 system-ui, sans-serif'
  close.style.cursor = 'pointer'
  close.addEventListener('click', () => {
    root.hidden = true
  })

  root.append(message, close)
  document.documentElement.append(root)
  return root
}
