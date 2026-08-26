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
  watchSettings,
  type ExtensionMessage,
  type ExtensionResponse,
  type ExtensionSettings,
  type MessageResponse,
  type SettingsResponse,
} from '../shared/messages'

let session: YoutubeSubtitleSession | undefined
let renderer: SubtitleOverlayRenderer | undefined
let aiModeActive = false
let lastVideoId = readVideoId()
let animationFrameId: number | undefined
let navigationPollId: number | undefined
let captionRetryTimeoutId: number | undefined
let activationRetryTimeoutId: number | undefined
let activationRetryGeneration = 0
let suppressCcOffUntil = 0
let autoCcToggled = false
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
    if (nextSettings.enabled) {
      void activateAiTranslate(nextSettings)
    } else {
      deactivateAiTranslate()
    }
  })
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
  hideNativeCaptions()
  autoCcToggled = false
  waitingForInitialCaptions = true
  void forceSubtitleReload()
  void scheduleCurrentWindow()
  window.clearTimeout(captionRetryTimeoutId)
  captionRetryTimeoutId = window.setTimeout(() => {
    captionRetryTimeoutId = undefined
    if (aiModeActive && (!session?.track || session.segments.length === 0)) {
      void forceSubtitleReload()
    }
  }, 1_000)
}

async function activateAiTranslate(
  settingsOverride?: ExtensionSettings,
  showUnavailableStatus = true,
  availabilityOverride?: CaptionAvailability,
  isCurrent?: () => boolean,
): Promise<boolean> {
  const settings = settingsOverride ?? (await loadSettingsForActivation())
  if (!settings || isCurrent?.() === false) return false

  const availability = availabilityOverride ?? (await getCurrentCaptionAvailability())
  if (isCurrent?.() === false) return false

  if (availability !== 'available') {
    deactivateAiTranslate()
    void syncTranslateToggle()
    if (showUnavailableStatus) {
      showStatusOverlay('AI Translate: YouTube captions not provided')
    }
    return false
  }

  const validation = await sendMessage<MessageResponse>({
    type: 'VALIDATE_ACTIVE_PROVIDER',
  })
  if (!validation.ok) {
    showStatusOverlay(`AI Translate: ${validation.error}`)
    return false
  }
  if (isCurrent?.() === false) return false

  aiModeActive = true
  createSession({ ...settings, enabled: true })
  armCaptionCapture()
  startRenderLoop()
  startNavigationPoll()
  void syncTranslateToggle()
  return true
}

function teardownAiTranslate(): void {
  const wasActive = aiModeActive
  cancelActivationRetry()
  aiModeActive = false
  waitingForInitialCaptions = false
  window.clearTimeout(captionRetryTimeoutId)
  captionRetryTimeoutId = undefined
  session?.stop()
  session = undefined
  renderer?.clear()
  stopRenderLoop()
  stopNavigationPoll()
  if (wasActive) void syncTranslateToggle()
}

function deactivateAiTranslate(): void {
  teardownAiTranslate()
  showNativeCaptions()
}

async function scheduleCurrentWindow(video = document.querySelector('video')): Promise<void> {
  if (!aiModeActive || !session || !video) return

  const ccEnabled = isCcEnabled()
  if (!ccEnabled) {
    if (waitingForInitialCaptions || Date.now() < suppressCcOffUntil) return

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

async function forceSubtitleReload(): Promise<void> {
  const button = findCaptionButton()
  if (!button) {
    showStatusOverlay('AI Translate: CC button not found')
    return
  }

  const isOn = button.getAttribute('aria-pressed') === 'true'
  suppressCcOffUntil = Date.now() + 1_500

  if (!isOn) {
    if (autoCcToggled) {
      return
    }

    autoCcToggled = true
    suppressCcOffUntil = Date.now() + 3_000
    button.click()
    return
  }

  button.click()
  await new Promise((resolve) => window.setTimeout(resolve, 250))
  if (aiModeActive) button.click()
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
    return 'unavailable'
  }
}

function createSession(settings: ExtensionSettings): void {
  session?.stop()
  renderer?.clear()
  session = new YoutubeSubtitleSession(settings, createRuntimeTranslatorClient())

  session.fatalErrorHandler = (error: string) => {
    showStatusOverlay(`AI Translate error: ${error}`)
    // Per spec: do not restore native captions on fatal error
    teardownAiTranslate()
  }

  session.windowFailedHandler = (_windowId: string, error: string) => {
    showStatusOverlay(`AI Translate: ${error}`)
  }

  renderer = new SubtitleOverlayRenderer()
  session.start()
}

function readVideoId(): string {
  return new URL(location.href).searchParams.get('v') ?? ''
}

async function loadSettingsForActivation(): Promise<ExtensionSettings | undefined> {
  const response = await sendMessage<SettingsResponse>({
    type: 'GET_SETTINGS',
  })
  if (!response.ok) {
    showStatusOverlay(`AI Translate: ${response.error}`)
    return undefined
  }

  return response.settings
}

const ACTIVATION_RETRY_DELAY_MS = 500
const ACTIVATION_RETRY_MAX_ATTEMPTS = 20

function cancelActivationRetry(): void {
  window.clearTimeout(activationRetryTimeoutId)
  activationRetryTimeoutId = undefined
  activationRetryGeneration += 1
}

function startStoredStateActivation(settings: ExtensionSettings): void {
  cancelActivationRetry()
  const retryGeneration = activationRetryGeneration
  void retryStoredStateActivation(settings, retryGeneration)
}

async function retryStoredStateActivation(
  settings: ExtensionSettings,
  retryGeneration: number,
  attempt = 0,
): Promise<void> {
  const isCurrent = () => retryGeneration === activationRetryGeneration
  const availability = await getCurrentCaptionAvailability()
  if (!isCurrent()) return

  if (availability === 'available') {
    if (await activateAiTranslate(settings, false, availability, isCurrent)) {
      cancelActivationRetry()
    }
    return
  }

  if (availability === 'unavailable' || attempt === ACTIVATION_RETRY_MAX_ATTEMPTS) {
    deactivateAiTranslate()
    void syncTranslateToggle()
    return
  }

  activationRetryTimeoutId = window.setTimeout(() => {
    activationRetryTimeoutId = undefined
    void retryStoredStateActivation(settings, retryGeneration, attempt + 1)
  }, ACTIVATION_RETRY_DELAY_MS)
}

async function applyStoredEnabledState(): Promise<void> {
  const retryGeneration = activationRetryGeneration
  const response = await sendMessage<SettingsResponse>({
    type: 'GET_SETTINGS',
  })
  if (!response.ok || retryGeneration !== activationRetryGeneration) return

  if (response.settings.enabled) {
    startStoredStateActivation(response.settings)
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
