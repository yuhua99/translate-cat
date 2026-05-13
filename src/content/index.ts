import {
  CAPTION_EVENT,
  CAPTION_REQUEST_EVENT,
  type CaptionsCapturedEventDetail,
} from '../youtube/caption-capture-event'
import { findCaptionButton, hasAvailableCaptions } from '../youtube/caption-availability'
import { hideNativeCaptions, showNativeCaptions } from '../youtube/native-caption-hider'

import { YoutubeSubtitleSession } from '../youtube/session'
import { injectTranslateToggle, syncTranslateToggle } from '../youtube/translate-toggle'
import { listenForMainVideoLoads } from '../youtube/video-load'
import { showStatusOverlay } from '../youtube/status-overlay'
import { SubtitleOverlayRenderer } from '../youtube/subtitle-overlay-renderer'
import { createRuntimeTranslatorClient } from '../youtube/translator-client'
import type {
  ExtensionMessage,
  ExtensionResponse,
  ExtensionSettings,
  MessageResponse,
  SettingsResponse,
} from '../shared/messages'

let session: YoutubeSubtitleSession | undefined
let renderer: SubtitleOverlayRenderer | undefined
let aiModeActive = false
let lastVideoId = readVideoId()
let animationFrameId: number | undefined
let lastCaptionRequestAt = 0
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
  window.setInterval(handleMaybeVideoChanged, 1_000)
}

function listenForSettingsChanges(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes.settings) return
    const nextSettings = changes.settings.newValue as ExtensionSettings | undefined
    if (!nextSettings) return

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
  hideNativeCaptions()
}

async function activateAiTranslate(
  settingsOverride?: ExtensionSettings,
  showUnavailableStatus = true,
): Promise<boolean> {
  const settings = settingsOverride ?? (await loadSettingsForActivation())
  if (!settings) return false

  if (!(await canUseCurrentCaptions())) {
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
    void setEnabledSetting(false)
    chrome.runtime.openOptionsPage()
    return false
  }

  aiModeActive = true
  createSession({ ...settings, enabled: true })
  hideNativeCaptions()
  autoCcToggled = false
  waitingForInitialCaptions = true
  requestCurrentCaptions()
  void forceSubtitleReload()
  void scheduleCurrentWindow()
  window.setTimeout(() => {
    if (aiModeActive && (!session?.track || session.segments.length === 0)) {
      void forceSubtitleReload()
    }
  }, 1_000)
  startRenderLoop()
  return true
}

function deactivateAiTranslate(): void {
  aiModeActive = false
  waitingForInitialCaptions = false
  session?.stop()
  session = undefined
  renderer?.clear()
  showNativeCaptions()
  stopRenderLoop()
}

async function scheduleCurrentWindow(video = document.querySelector('video')): Promise<void> {
  if (!aiModeActive || !session || !video) return

  if (!session.track) {
    requestCurrentCaptions()
  }

  const ccEnabled = isCcEnabled()
  if (!ccEnabled) {
    if (waitingForInitialCaptions || Date.now() < suppressCcOffUntil) return

    if (!(await canUseCurrentCaptions())) {
      deactivateAiTranslate()
      void syncTranslateToggle()
      return
    }

    void setEnabledSetting(false)
    deactivateAiTranslate()
    return
  }

  if (session.track) {
    waitingForInitialCaptions = false
  }

  const currentTimeMs = video.currentTime * 1000
  const currentSession = session
  hideNativeCaptions()
  await currentSession.ensureTranslations(currentTimeMs, true)
  renderer?.render(currentSession.translatedCues, currentTimeMs)
}

function requestCurrentCaptions(): void {
  const now = Date.now()
  if (now - lastCaptionRequestAt < 1_000) return
  lastCaptionRequestAt = now
  window.dispatchEvent(new CustomEvent(CAPTION_REQUEST_EVENT))
  window.postMessage({ source: 'simple-translator', type: CAPTION_REQUEST_EVENT }, '*')
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
      renderer?.render(session.translatedCues, video.currentTime * 1000)
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

async function canUseCurrentCaptions(): Promise<boolean> {
  try {
    return await hasAvailableCaptions()
  } catch {
    return false
  }
}

function createSession(settings: ExtensionSettings): void {
  session?.stop()
  renderer?.clear()
  session = new YoutubeSubtitleSession(settings, createRuntimeTranslatorClient())

  session.fatalErrorHandler = (error: string) => {
    showStatusOverlay(`AI Translate error: ${error}`)
    aiModeActive = false
    session?.stop()
    renderer?.clear()
    // Per spec: do not restore native captions on fatal error
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

async function setEnabledSetting(enabled: boolean): Promise<void> {
  const response = await sendMessage<SettingsResponse>({
    type: 'GET_SETTINGS',
  })
  if (!response.ok || response.settings.enabled === enabled) return

  await sendMessage<SettingsResponse>({
    type: 'SET_SETTINGS',
    settings: { ...response.settings, enabled },
  })
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

async function applyStoredEnabledState(): Promise<void> {
  const response = await sendMessage<SettingsResponse>({
    type: 'GET_SETTINGS',
  })
  if (!response.ok) return

  if (response.settings.enabled) {
    await activateAiTranslate(response.settings, false)
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
  injectTranslateToggle()
  void applyStoredEnabledState()

  window.addEventListener('pagehide', () => {
    session?.stop()
  })
}

boot()
