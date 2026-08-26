import {
  DEFAULT_SETTINGS,
  watchProviderChanges,
  watchSettings,
  type ExtensionMessage,
  type ExtensionResponse,
  type ExtensionSettings,
  type MessageResponse,
  type SettingsResponse,
} from '../shared/messages'
import { findCaptionButton, hasAvailableCaptions } from './caption-availability'

function sendMessage<TResponse extends ExtensionResponse>(
  message: ExtensionMessage,
): Promise<TResponse> {
  return chrome.runtime.sendMessage(message)
}

const BUTTON_ID = 'simple-translator-toggle'
const TOOLTIP_ID = 'simple-translator-toggle-tooltip'
const SYNC_DEBOUNCE_MS = 150
const CAPTION_CONTROL_SELECTOR = '.html5-video-player, .ytp-chrome-controls, .ytp-subtitles-button'
type ToggleState = { kind: 'active' | 'inactive' } | { kind: 'unavailable'; reason: string }
type TranslateToggleOptions = {
  isActive: () => boolean
  onActivateRequest: () => Promise<boolean> | void
  onDeactivateRequest: () => void
}

let isActive = () => false
let onActivateRequest: () => Promise<boolean> | void = () => {}
let onDeactivateRequest = () => {}
let syncSequence = 0
let syncTimeoutId: number | undefined

function svgMarkup(state: ToggleState): string {
  const active = state.kind === 'active'
  const opacity = state.kind === 'unavailable' ? '0.3' : '1'
  const bgFill = active ? 'fill="white"' : 'fill="none" stroke="white" stroke-width="1.8"'
  const lineStroke = active ? 'black' : 'white'
  return `<svg fill="none" fill-opacity="${opacity}" stroke-opacity="${opacity}" height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg">
  <rect x="1" y="5" width="20" height="16" rx="2" ${bgFill}></rect>
  <line x1="5" y1="13" x2="17" y2="13" stroke="${lineStroke}" stroke-width="1.8" stroke-linecap="round"></line>
  <line x1="5" y1="17" x2="17" y2="17" stroke="${lineStroke}" stroke-width="1.8" stroke-linecap="round"></line>
  <rect x="11" y="0" width="13" height="10" rx="2" fill="#FF0000"></rect>
  <text x="17.5" y="8" font-family="Arial, sans-serif" font-size="8" font-weight="700" fill="white" text-anchor="middle" letter-spacing="0.2">AI</text>
</svg>`
}

function createToggleButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.id = BUTTON_ID
  button.className = 'ytp-button'
  button.type = 'button'
  button.setAttribute('aria-pressed', 'false')

  const iconWrapper = document.createElement('div')
  iconWrapper.innerHTML = svgMarkup({ kind: 'inactive' })
  button.append(iconWrapper)

  button.addEventListener('pointerenter', () => {
    showTooltip(button)
  })
  button.addEventListener('pointerleave', hideTooltip)
  button.addEventListener('click', () => {
    hideTooltip()
    void toggleEnabled()
  })

  return button
}

async function resolveToggleState(captionButton = findCaptionButton()): Promise<ToggleState> {
  if (!(await hasAvailableCaptions(captionButton))) {
    return { kind: 'unavailable', reason: 'YouTube captions not provided' }
  }

  const validation = await sendMessage<MessageResponse>({ type: 'VALIDATE_ACTIVE_PROVIDER' })
  if (!validation.ok) return { kind: 'unavailable', reason: validation.error }

  return { kind: isActive() ? 'active' : 'inactive' }
}

function stateText(state: ToggleState): string {
  return state.kind === 'unavailable'
    ? `AI Translate: unavailable (${state.reason})`
    : state.kind === 'active'
      ? 'AI Translate: ON (click to disable)'
      : 'AI Translate: OFF (click to enable)'
}

function applyToggleState(button: HTMLButtonElement, state: ToggleState): void {
  const stateId = state.kind === 'unavailable' ? `${state.kind}:${state.reason}` : state.kind
  if (button.dataset.state === stateId) return

  const text = stateText(state)
  button.dataset.state = stateId
  button.setAttribute('aria-disabled', String(state.kind === 'unavailable'))
  button.setAttribute('aria-pressed', String(state.kind === 'active'))
  button.setAttribute('aria-label', text)
  const tooltipText = document.querySelector(`#${TOOLTIP_ID} .ytp-tooltip-text`)
  if (tooltipText) tooltipText.textContent = text

  const iconWrapper = button.querySelector('div')
  if (iconWrapper) iconWrapper.innerHTML = svgMarkup(state)
}

function getTooltip(button: HTMLButtonElement): HTMLDivElement {
  const existing = document.getElementById(TOOLTIP_ID) as HTMLDivElement | null
  if (existing) return existing

  const tooltip = document.createElement('div')
  tooltip.id = TOOLTIP_ID
  tooltip.className = 'ytp-tooltip ytp-bottom'
  tooltip.style.display = 'none'

  const wrapper = document.createElement('div')
  wrapper.className = 'ytp-tooltip-text-wrapper'
  const text = document.createElement('span')
  text.className = 'ytp-tooltip-text'
  wrapper.append(text)
  tooltip.append(wrapper)

  const player = document.querySelector('.html5-video-player')
  const parent = player ?? button.offsetParent ?? document.body
  parent.append(tooltip)
  return tooltip
}

function positionTooltip(button: HTMLButtonElement, tooltip: HTMLDivElement): void {
  const buttonRect = button.getBoundingClientRect()
  const parentRect = (tooltip.offsetParent ?? document.body).getBoundingClientRect()
  const progressBar =
    button.closest('.html5-video-player')?.querySelector('.ytp-progress-bar-container') ??
    document.querySelector('.ytp-progress-bar-container')
  const anchorTop = progressBar?.getBoundingClientRect().top ?? buttonRect.top
  tooltip.style.left = `${buttonRect.left - parentRect.left + buttonRect.width / 2}px`
  tooltip.style.bottom = `${parentRect.bottom - anchorTop + 8}px`
  tooltip.style.transform = 'translateX(-50%)'
}

function showTooltip(button: HTMLButtonElement): void {
  const tooltip = getTooltip(button)
  const text = tooltip.querySelector('.ytp-tooltip-text')
  if (text) text.textContent = button.getAttribute('aria-label') ?? ''
  tooltip.style.display = 'block'
  positionTooltip(button, tooltip)
}

function hideTooltip(): void {
  const tooltip = document.getElementById(TOOLTIP_ID) as HTMLDivElement | null
  if (tooltip) tooltip.style.display = 'none'
}

export async function syncTranslateToggle(): Promise<void> {
  const sequence = ++syncSequence

  try {
    const captionButton = findCaptionButton()
    if (!captionButton) {
      document.getElementById(BUTTON_ID)?.remove()
      document.getElementById(TOOLTIP_ID)?.remove()
      return
    }

    const state = await resolveToggleState(captionButton)
    if (sequence !== syncSequence) return

    let button = document.getElementById(BUTTON_ID) as HTMLButtonElement | null
    if (!button) {
      const parent = captionButton.parentElement
      if (!parent) return

      button = createToggleButton()
      parent.insertBefore(button, captionButton)
    }

    applyToggleState(button, state)
  } catch (error) {
    console.error('Failed to sync AI translate toggle', error)
  }
}

async function toggleEnabled(): Promise<void> {
  const button = document.getElementById(BUTTON_ID) as HTMLButtonElement | null
  if (!button || button.dataset.state?.startsWith('unavailable')) return

  const settings = await loadSettings()
  if (isActive()) {
    const response = await sendMessage<SettingsResponse>({
      type: 'SET_SETTINGS',
      settings: { ...settings, enabled: false },
    })
    if (!response.ok) return

    onDeactivateRequest()
    await syncTranslateToggle()
    return
  }

  if (settings.enabled) {
    await onActivateRequest()
    await syncTranslateToggle()
    return
  }

  const response = await sendMessage<SettingsResponse>({
    type: 'SET_SETTINGS',
    settings: { ...settings, enabled: true },
  })
  if (!response.ok) return

  await syncTranslateToggle()
}

async function loadSettings(): Promise<ExtensionSettings> {
  const response = await sendMessage<SettingsResponse>({ type: 'GET_SETTINGS' })
  return response.ok ? response.settings : DEFAULT_SETTINGS
}

function updateButtonFromSettings(): void {
  void syncTranslateToggle()
}

function touchesCaptionControls(record: MutationRecord): boolean {
  if (record.target instanceof Element && record.target.closest(CAPTION_CONTROL_SELECTOR))
    return true

  for (const node of [...record.addedNodes, ...record.removedNodes]) {
    if (!(node instanceof Element)) continue
    if (node.matches(CAPTION_CONTROL_SELECTOR) || node.querySelector(CAPTION_CONTROL_SELECTOR))
      return true
  }

  return false
}

function scheduleTranslateToggleSync(): void {
  if (syncTimeoutId !== undefined) window.clearTimeout(syncTimeoutId)

  syncTimeoutId = window.setTimeout(() => {
    syncTimeoutId = undefined
    void syncTranslateToggle()
  }, SYNC_DEBOUNCE_MS)
}

function observeCaptionButton(): void {
  const observer = new MutationObserver((records) => {
    if (records.some(touchesCaptionControls)) scheduleTranslateToggleSync()
  })
  observer.observe(document.body, { childList: true, subtree: true })
}

function listenForSettingsChanges(): void {
  watchSettings(updateButtonFromSettings)
  watchProviderChanges(() => {
    void syncTranslateToggle()
  })
}

export function injectTranslateToggle(options: TranslateToggleOptions): void {
  isActive = options.isActive
  onActivateRequest = options.onActivateRequest
  onDeactivateRequest = options.onDeactivateRequest

  void loadSettings().then(() => {
    observeCaptionButton()
    void syncTranslateToggle()
    listenForSettingsChanges()
    updateButtonFromSettings()
  })
}
