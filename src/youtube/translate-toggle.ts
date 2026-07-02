import {
  DEFAULT_SETTINGS,
  type ExtensionMessage,
  type ExtensionResponse,
  type ExtensionSettings,
  type SettingsResponse,
} from '../shared/messages'
import { findCaptionButton, hasAvailableCaptions } from './caption-availability'

function sendMessage<TResponse extends ExtensionResponse>(
  message: ExtensionMessage,
): Promise<TResponse> {
  return chrome.runtime.sendMessage(message)
}

const BUTTON_ID = 'simple-translator-toggle'
const SYNC_DEBOUNCE_MS = 150
const CAPTION_CONTROL_SELECTOR = '.html5-video-player, .ytp-chrome-controls, .ytp-subtitles-button'
type ToggleState = 'active' | 'inactive' | 'unavailable'
let enabled = false
let syncSequence = 0
let syncTimeoutId: number | undefined

function svgMarkup(state: ToggleState): string {
  const active = state === 'active'
  const opacity = state === 'unavailable' ? '0.3' : '1'
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
  button.title = 'Toggle AI Translate'

  const iconWrapper = document.createElement('div')
  iconWrapper.innerHTML = svgMarkup('inactive')
  button.append(iconWrapper)

  button.addEventListener('click', () => {
    void toggleEnabled()
  })

  return button
}

async function resolveToggleState(captionButton = findCaptionButton()): Promise<ToggleState> {
  if (!(await hasAvailableCaptions(captionButton))) return 'unavailable'

  return enabled ? 'active' : 'inactive'
}

function applyToggleState(button: HTMLButtonElement, state: ToggleState): void {
  if (button.dataset.state === state) return

  button.dataset.state = state
  button.disabled = state === 'unavailable'
  button.setAttribute('aria-disabled', String(state === 'unavailable'))
  button.setAttribute('aria-pressed', String(state === 'active'))
  button.title =
    state === 'unavailable'
      ? 'AI Translate: unavailable (YouTube captions not provided)'
      : state === 'active'
        ? 'AI Translate: ON (click to disable)'
        : 'AI Translate: OFF (click to enable)'

  const iconWrapper = button.querySelector('div')
  if (iconWrapper) iconWrapper.innerHTML = svgMarkup(state)
}

export async function syncTranslateToggle(): Promise<void> {
  const sequence = ++syncSequence

  try {
    const captionButton = findCaptionButton()
    if (!captionButton) {
      document.getElementById(BUTTON_ID)?.remove()
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
  if (button?.disabled) return

  const settings = await loadSettings()
  const next = { ...settings, enabled: !settings.enabled }
  enabled = next.enabled

  await sendMessage<SettingsResponse>({ type: 'SET_SETTINGS', settings: next })

  await syncTranslateToggle()
}

async function loadSettings(): Promise<ExtensionSettings> {
  const response = await sendMessage<SettingsResponse>({ type: 'GET_SETTINGS' })
  return response.ok ? response.settings : DEFAULT_SETTINGS
}

function updateButtonFromSettings(settings: ExtensionSettings): void {
  enabled = settings.enabled
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
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes.settings) return
    const next = changes.settings.newValue as ExtensionSettings | undefined
    if (next) updateButtonFromSettings(next)
  })
}

export function injectTranslateToggle(): void {
  void loadSettings().then((settings) => {
    observeCaptionButton()
    void syncTranslateToggle()
    listenForSettingsChanges()
    updateButtonFromSettings(settings)
  })
}
