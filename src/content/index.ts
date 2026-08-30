import { CAPTION_EVENT, type CaptionsCapturedEventDetail } from '../youtube/caption-capture-event'
import {
  findCaptionButton,
  getCaptionAvailability,
  type CaptionAvailability,
} from '../youtube/caption-availability'
import { hideNativeCaptions, showNativeCaptions } from '../youtube/native-caption-hider'

import { YoutubeSubtitleSession } from '../youtube/session'
import { injectTranslateToggle, syncTranslateToggle } from '../youtube/translate-toggle'
import { listenForMainVideoLoads } from '../youtube/video-load'
import { showStatusOverlay } from '../youtube/status-overlay'
import { SubtitleOverlayRenderer } from '../youtube/subtitle-overlay-renderer'
import { createRuntimeTranslatorClient } from '../youtube/translator-client'
import {
  watchProviderChanges,
  watchSettings,
  type ExtensionMessage,
  type ExtensionResponse,
  type ExtensionSettings,
  type MessageResponse,
  type SettingsResponse,
} from '../shared/messages'

class TranslationActivation {
  readonly controller = new AbortController()
  retryTimeoutId: number | undefined
  session?: YoutubeSubtitleSession

  dispose(): void {
    this.controller.abort()
    window.clearTimeout(this.retryTimeoutId)
    this.retryTimeoutId = undefined
    this.session?.stop()
  }

  isCurrent(): boolean {
    return translationActivation === this && !this.controller.signal.aborted
  }
}

class CaptionReload {
  readonly controller = new AbortController()
  retryTimeoutId: number | undefined
  captionButtonTurnedOff?: HTMLButtonElement
  suppressCcOffUntil = 0
  autoCcToggled = false

  dispose(): void {
    this.controller.abort()
    window.clearTimeout(this.retryTimeoutId)
    this.retryTimeoutId = undefined

    const button = this.captionButtonTurnedOff
    this.captionButtonTurnedOff = undefined
    if (button?.getAttribute('aria-pressed') === 'false') button.click()
  }

  isCurrent(): boolean {
    return captionReload === this && !this.controller.signal.aborted
  }
}

let session: YoutubeSubtitleSession | undefined
let renderer: SubtitleOverlayRenderer | undefined
let aiModeActive = false
let lastVideoId = readVideoId()
let animationFrameId: number | undefined
let navigationPollId: number | undefined
let translationActivation: TranslationActivation | undefined
let captionReload: CaptionReload | undefined
let waitingForInitialCaptions = false

function sendMessage<TResponse extends ExtensionResponse>(
  message: ExtensionMessage,
): Promise<TResponse> {
  return chrome.runtime.sendMessage(message)
}

function listenForCaptionCapture(): void {
  window.addEventListener(CAPTION_EVENT, (event) => {
    const detail = (event as CustomEvent<CaptionsCapturedEventDetail>).detail
    if (detail) handleCaptionCapture(detail)
  })

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const data = event.data as {
      source?: string
      type?: string
      detail?: CaptionsCapturedEventDetail
    }
    if (data.source === 'simple-translator' && data.type === CAPTION_EVENT && data.detail) {
      handleCaptionCapture(data.detail)
    }
  })
}

function handleCaptionCapture(detail: CaptionsCapturedEventDetail): void {
  if (!session || !detail.responseText) return

  session.handleCapturedCaptions(detail)
  void scheduleCurrentWindow()
}

function listenForPlayback(): void {
  document.addEventListener(
    'timeupdate',
    (event) => {
      if (event.target instanceof HTMLVideoElement) {
        void scheduleCurrentWindow(event.target)
      }
    },
    true,
  )

  document.addEventListener(
    'seeked',
    (event) => {
      if (event.target instanceof HTMLVideoElement) {
        void scheduleCurrentWindow(event.target)
      }
    },
    true,
  )
}

function listenForNavigation(): void {
  window.addEventListener('yt-navigate-finish', handleMaybeVideoChanged)
}

function startNavigationPoll(): void {
  if (navigationPollId !== undefined) return
  navigationPollId = window.setInterval(handleMaybeVideoChanged, 1_000)
}

function stopNavigationPoll(): void {
  if (navigationPollId === undefined) return
  window.clearInterval(navigationPollId)
  navigationPollId = undefined
}

function listenForSettingsChanges(): void {
  watchSettings((nextSettings) => {
    restartAiTranslate(nextSettings)
  })
  watchProviderChanges(() => {
    restartAiTranslate()
  })
}

function restartAiTranslate(settingsOverride?: ExtensionSettings): void {
  const wasActive = aiModeActive
  const activation = startActivation()
  teardownAiTranslate()
  if (wasActive) showNativeCaptions()

  if (settingsOverride) {
    if (!settingsOverride.enabled) {
      showNativeCaptions()
      return
    }
    void activateAiTranslate(settingsOverride, true, undefined, activation)
    return
  }

  void restartAiTranslateWithLatestSettings(activation)
}

async function restartAiTranslateWithLatestSettings(
  activation: TranslationActivation,
): Promise<void> {
  const settings = await loadSettingsForActivation(activation)
  if (!activation.isCurrent() || !settings) return

  if (!settings.enabled) return

  await activateAiTranslate(settings, true, undefined, activation)
}

function handleMaybeVideoChanged(): void {
  const videoId = readVideoId()
  if (videoId === lastVideoId) return

  lastVideoId = videoId
  renderer?.clear()

  if (!aiModeActive) {
    session?.stop()
    return
  }

  session?.resetForNavigation(videoId)
  armCaptionCapture()
}

function armCaptionCapture(): void {
  disposeCaptionReload()
  const reload = new CaptionReload()
  captionReload = reload
  hideNativeCaptions()
  waitingForInitialCaptions = true
  void forceSubtitleReload(reload)
  void scheduleCurrentWindow()
  reload.retryTimeoutId = window.setTimeout(() => {
    reload.retryTimeoutId = undefined
    if (reload.isCurrent() && aiModeActive && (!session?.track || session.segments.length === 0)) {
      void forceSubtitleReload(reload)
    }
  }, 1_000)
}

async function activateAiTranslate(
  settingsOverride?: ExtensionSettings,
  showUnavailableStatus = true,
  availabilityOverride?: CaptionAvailability,
  activation = startActivation(),
): Promise<boolean> {
  const settings = settingsOverride ?? (await loadSettingsForActivation(activation))
  if (!settings || !activation.isCurrent()) return false

  const availability = availabilityOverride ?? (await getCurrentCaptionAvailability())
  if (!activation.isCurrent()) return false

  if (availability !== 'available') {
    deactivateAiTranslate()
    void syncTranslateToggle()
    if (showUnavailableStatus) {
      showStatusOverlay(
        chrome.i18n.getMessage('aiTranslateDetail', chrome.i18n.getMessage('captionsNotProvided')),
      )
    }
    return false
  }

  const validation = await sendMessage<MessageResponse>({
    type: 'VALIDATE_ACTIVE_PROVIDER',
  })
  if (!activation.isCurrent()) return false
  if (!validation.ok) {
    showStatusOverlay(chrome.i18n.getMessage('aiTranslateDetail', validation.error))
    return false
  }

  window.clearTimeout(activation.retryTimeoutId)
  activation.retryTimeoutId = undefined
  aiModeActive = true
  createSession({ ...settings, enabled: true }, activation)
  armCaptionCapture()
  startRenderLoop()
  startNavigationPoll()
  void syncTranslateToggle()
  return true
}

function teardownAiTranslate(): void {
  const wasActive = aiModeActive
  disposeCaptionReload()
  aiModeActive = false
  waitingForInitialCaptions = false
  session?.stop()
  session = undefined
  renderer?.clear()
  stopRenderLoop()
  stopNavigationPoll()
  if (wasActive) void syncTranslateToggle()
}

function deactivateAiTranslate(): void {
  startActivation()
  teardownAiTranslate()
  showNativeCaptions()
}

async function scheduleCurrentWindow(video = document.querySelector('video')): Promise<void> {
  if (!aiModeActive || !session || !video) return

  const ccEnabled = isCcEnabled()
  if (!ccEnabled) {
    if (waitingForInitialCaptions || Date.now() < (captionReload?.suppressCcOffUntil ?? 0)) return

    deactivateAiTranslate()
    void syncTranslateToggle()
    return
  }

  if (session.track) {
    waitingForInitialCaptions = false
  }

  const currentTimeMs = video.currentTime * 1000
  hideNativeCaptions()
  await session.ensureTranslations(currentTimeMs, true)
}

function disposeCaptionReload(): void {
  captionReload?.dispose()
  captionReload = undefined
}

async function forceSubtitleReload(reload: CaptionReload): Promise<void> {
  if (!reload.isCurrent()) return

  const reloadSession = session
  const button = findCaptionButton()
  if (!button) {
    showStatusOverlay(chrome.i18n.getMessage('contentCcButtonNotFound'))
    return
  }

  const isOn = button.getAttribute('aria-pressed') === 'true'
  reload.suppressCcOffUntil = Date.now() + 1_500

  if (!isOn) {
    if (reload.autoCcToggled) {
      return
    }

    reload.autoCcToggled = true
    reload.suppressCcOffUntil = Date.now() + 3_000
    button.click()
    return
  }

  reload.captionButtonTurnedOff = button
  button.click()
  await waitForDelay(250, reload.controller.signal)
  if (!reload.isCurrent() || reloadSession !== session) return

  reload.captionButtonTurnedOff = undefined
  if (aiModeActive) button.click()
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }

    let timeoutId: number | undefined
    const finish = () => {
      window.clearTimeout(timeoutId)
      signal.removeEventListener('abort', finish)
      resolve()
    }

    timeoutId = window.setTimeout(finish, delayMs)
    signal.addEventListener('abort', finish, { once: true })
  })
}

function startRenderLoop(): void {
  if (animationFrameId !== undefined) return

  const render = () => {
    const video = document.querySelector('video')
    if (aiModeActive && session && video) {
      const currentTimeMs = video.currentTime * 1000
      renderer?.render(
        session.translatedCues,
        currentTimeMs,
        session.pendingSegmentAt(currentTimeMs)?.text,
      )
    }
    animationFrameId = window.requestAnimationFrame(render)
  }

  animationFrameId = window.requestAnimationFrame(render)
}

function stopRenderLoop(): void {
  if (animationFrameId === undefined) return
  window.cancelAnimationFrame(animationFrameId)
  animationFrameId = undefined
}

function isCcEnabled(): boolean {
  const button = findCaptionButton()
  return button !== null && button.getAttribute('aria-pressed') !== 'false'
}

async function getCurrentCaptionAvailability(): Promise<CaptionAvailability> {
  try {
    return await getCaptionAvailability()
  } catch {
    return 'not-ready'
  }
}

function createSession(settings: ExtensionSettings, activation: TranslationActivation): void {
  session?.stop()
  renderer?.clear()
  const nextSession = new YoutubeSubtitleSession(settings, createRuntimeTranslatorClient())
  activation.session = nextSession
  session = nextSession

  nextSession.fatalErrorHandler = (error: string) => {
    if (session !== nextSession) return
    showStatusOverlay(chrome.i18n.getMessage('aiTranslateDetail', String(error)))
    // Per spec: do not restore native captions on fatal error
    teardownAiTranslate()
  }

  nextSession.windowFailedHandler = (error: string) => {
    if (session !== nextSession) return
    showStatusOverlay(chrome.i18n.getMessage('aiTranslateDetail', String(error)))
  }

  renderer = new SubtitleOverlayRenderer()
}

function readVideoId(): string {
  return new URL(location.href).searchParams.get('v') ?? ''
}

async function loadSettingsForActivation(
  activation?: TranslationActivation,
): Promise<ExtensionSettings | undefined> {
  const response = await sendMessage<SettingsResponse>({
    type: 'GET_SETTINGS',
  })
  if (!response.ok) {
    if (!activation || activation.isCurrent()) {
      showStatusOverlay(chrome.i18n.getMessage('aiTranslateDetail', response.error))
    }
    return undefined
  }

  return response.settings
}

const ACTIVATION_RETRY_DELAY_MS = 500
const ACTIVATION_RETRY_MAX_ATTEMPTS = 20

function startActivation(): TranslationActivation {
  translationActivation?.dispose()
  const activation = new TranslationActivation()
  translationActivation = activation
  return activation
}

function startStoredStateActivation(
  settings: ExtensionSettings,
  activation: TranslationActivation,
): void {
  void retryStoredStateActivation(settings, activation)
}

async function retryStoredStateActivation(
  settings: ExtensionSettings,
  activation: TranslationActivation,
  attempt = 0,
): Promise<void> {
  const availability = await getCurrentCaptionAvailability()
  if (!activation.isCurrent()) return

  if (availability === 'available') {
    if (await activateAiTranslate(settings, false, availability, activation)) {
      window.clearTimeout(activation.retryTimeoutId)
      activation.retryTimeoutId = undefined
    }
    return
  }

  if (availability === 'unavailable' || attempt === ACTIVATION_RETRY_MAX_ATTEMPTS) {
    deactivateAiTranslate()
    void syncTranslateToggle()
    return
  }

  activation.retryTimeoutId = window.setTimeout(() => {
    activation.retryTimeoutId = undefined
    void retryStoredStateActivation(settings, activation, attempt + 1)
  }, ACTIVATION_RETRY_DELAY_MS)
}

async function applyStoredEnabledState(): Promise<void> {
  const activation = startActivation()
  const response = await sendMessage<SettingsResponse>({
    type: 'GET_SETTINGS',
  })
  if (!response.ok || !activation.isCurrent()) return

  if (response.settings.enabled) {
    startStoredStateActivation(response.settings, activation)
  }
}

function boot(): void {
  listenForCaptionCapture()
  listenForPlayback()
  listenForNavigation()
  listenForMainVideoLoads(() => {
    void syncTranslateToggle()
    if (!aiModeActive) void applyStoredEnabledState()
  })
  listenForSettingsChanges()
  injectTranslateToggle({
    isActive: () => aiModeActive,
    onActivateRequest: activateAiTranslate,
    onDeactivateRequest: deactivateAiTranslate,
  })
  void applyStoredEnabledState()

  window.addEventListener('pagehide', () => {
    session?.stop()
  })
}

boot()
