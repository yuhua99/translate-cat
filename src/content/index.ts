import { CAPTION_EVENT, type CaptionsCapturedEventDetail } from '../youtube/caption-capture-event'
import {
  findCaptionButton,
  getCaptionAvailability,
  type CaptionAvailability,
} from '../youtube/caption-availability'
import { hideNativeCaptions, showNativeCaptions } from '../youtube/native-caption-hider'

import { YoutubeSubtitleSession } from '../youtube/session'
import { injectTranslateToggle, syncTranslateToggle } from '../youtube/translate-toggle'
import { listenForMainVideoLoads, parseYouTubeVideoId } from '../youtube/video-load'
import { showStatusOverlay } from '../youtube/status-overlay'
import { SubtitleOverlayRenderer } from '../youtube/subtitle-overlay-renderer'
import { createRuntimeTranslatorClient } from '../youtube/translator-client'
import {
  watchProviderSecretChanges,
  watchSettings,
  type ExtensionMessage,
  type ExtensionResponse,
  type ExtensionSettings,
  type MessageResponse,
  type SettingsResponse,
} from '../shared/messages'

class CaptionReload {
  readonly controller = new AbortController()
  retryTimeoutId: number | undefined
  captionButtonTurnedOff?: HTMLButtonElement
  suppressCcOffUntil = 0
  autoCcToggled = false

  get aborted(): boolean {
    return this.controller.signal.aborted
  }

  dispose(): void {
    this.controller.abort()
    window.clearTimeout(this.retryTimeoutId)
    this.retryTimeoutId = undefined

    const button = this.captionButtonTurnedOff
    this.captionButtonTurnedOff = undefined
    if (button?.getAttribute('aria-pressed') === 'false') button.click()
  }
}

class TranslateRun {
  readonly controller = new AbortController()
  session?: YoutubeSubtitleSession
  renderer?: SubtitleOverlayRenderer
  active = false
  waitingForInitialCaptions = false
  retryTimeoutId?: number
  captionReload?: CaptionReload
  animationFrameId?: number
  navigationPollId?: number

  get aborted(): boolean {
    return this.controller.signal.aborted
  }

  dispose(): void {
    this.controller.abort()
    window.clearTimeout(this.retryTimeoutId)
    this.retryTimeoutId = undefined
    this.captionReload?.dispose()
    this.captionReload = undefined
    this.active = false
    this.waitingForInitialCaptions = false
    this.session?.stop()
    this.session = undefined
    this.renderer?.clear()
    this.renderer = undefined
    if (this.animationFrameId !== undefined) {
      window.cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = undefined
    }
    if (this.navigationPollId !== undefined) {
      window.clearInterval(this.navigationPollId)
      this.navigationPollId = undefined
    }
  }
}

let currentRun: TranslateRun | undefined
let lastVideoId = readVideoId()

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
  const run = currentRun
  if (!run || run.aborted || !run.session || !detail.responseText) return

  run.session.handleCapturedCaptions(detail)
  void scheduleCurrentWindow(run)
}

function listenForPlayback(): void {
  document.addEventListener(
    'timeupdate',
    (event) => {
      const run = currentRun
      if (!run || run.aborted || !(event.target instanceof HTMLVideoElement)) return

      void scheduleCurrentWindow(run, event.target)
    },
    true,
  )

  document.addEventListener(
    'seeked',
    (event) => {
      const run = currentRun
      if (!run || run.aborted || !(event.target instanceof HTMLVideoElement)) return

      void scheduleCurrentWindow(run, event.target)
    },
    true,
  )
}

function listenForNavigation(): void {
  window.addEventListener('yt-navigate-finish', handleMaybeVideoChanged)
}

function startNavigationPoll(run: TranslateRun): void {
  if (run.aborted || run.navigationPollId !== undefined) return
  run.navigationPollId = window.setInterval(handleMaybeVideoChanged, 1_000)
}

function listenForSettingsChanges(): void {
  watchSettings((nextSettings) => {
    restartAiTranslate(nextSettings)
  })
  watchProviderSecretChanges(() => {
    restartAiTranslate()
  })
}

function restartAiTranslate(settingsOverride?: ExtensionSettings): void {
  const wasActive = currentRun?.active ?? false
  const run = startActivation()
  if (wasActive) void syncTranslateToggle()
  if (wasActive || settingsOverride?.enabled === false) showNativeCaptions()

  if (settingsOverride) {
    if (!settingsOverride.enabled) {
      return
    }
    void activateAiTranslate(settingsOverride, true, undefined, run)
    return
  }

  void restartAiTranslateWithLatestSettings(run)
}

async function restartAiTranslateWithLatestSettings(run: TranslateRun): Promise<void> {
  const settings = await loadSettingsForActivation(run)
  if (run.aborted || !settings) return

  if (!settings.enabled) return

  await activateAiTranslate(settings, true, undefined, run)
}

function handleMaybeVideoChanged(): void {
  const videoId = readVideoId()
  if (videoId === lastVideoId) return

  lastVideoId = videoId
  const run = currentRun
  if (!run || run.aborted) return

  run.renderer?.clear()
  if (!run.active) {
    run.session?.stop()
    return
  }

  run.session?.resetForNavigation(videoId)
  armCaptionCapture(run)
}

function armCaptionCapture(run: TranslateRun): void {
  if (run.aborted) return

  disposeCaptionReload(run)
  const reload = new CaptionReload()
  run.captionReload = reload
  hideNativeCaptions()
  run.waitingForInitialCaptions = true
  void forceSubtitleReload(run, reload)
  void scheduleCurrentWindow(run)
  reload.retryTimeoutId = window.setTimeout(() => {
    reload.retryTimeoutId = undefined
    if (
      run.aborted ||
      reload.aborted ||
      !run.active ||
      (run.session?.track && run.session.segments.length > 0)
    ) {
      return
    }
    void forceSubtitleReload(run, reload)
  }, 1_000)
}

async function activateAiTranslate(
  settingsOverride?: ExtensionSettings,
  showUnavailableStatus = true,
  availabilityOverride?: CaptionAvailability,
  run = startActivation(),
): Promise<boolean> {
  const settings = settingsOverride ?? (await loadSettingsForActivation(run))
  if (run.aborted || !settings) return false

  const availability = availabilityOverride ?? (await getCurrentCaptionAvailability())
  if (run.aborted) return false

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
  if (run.aborted) return false
  if (!validation.ok) {
    showStatusOverlay(chrome.i18n.getMessage('aiTranslateDetail', validation.error))
    return false
  }

  run.active = true
  createSession(run, { ...settings, enabled: true })
  armCaptionCapture(run)
  startRenderLoop(run)
  startNavigationPoll(run)
  void syncTranslateToggle()
  return true
}

function teardownAiTranslate(run: TranslateRun): void {
  const wasActive = run.active
  run.dispose()
  if (currentRun === run) currentRun = undefined
  if (wasActive) void syncTranslateToggle()
}

function deactivateAiTranslate(): void {
  if (currentRun) teardownAiTranslate(currentRun)
  showNativeCaptions()
}

async function scheduleCurrentWindow(
  run: TranslateRun,
  video = document.querySelector('video'),
): Promise<void> {
  if (!run || run.aborted || !run.active || !run.session || !video) return

  const ccEnabled = isCcEnabled()
  if (!ccEnabled) {
    if (
      run.waitingForInitialCaptions ||
      Date.now() < (run.captionReload?.suppressCcOffUntil ?? 0)
    ) {
      return
    }

    deactivateAiTranslate()
    void syncTranslateToggle()
    return
  }

  if (run.session.track) {
    run.waitingForInitialCaptions = false
  }

  const currentTimeMs = video.currentTime * 1000
  hideNativeCaptions()
  await run.session.ensureTranslations(currentTimeMs, true)
}

function disposeCaptionReload(run: TranslateRun): void {
  run.captionReload?.dispose()
  run.captionReload = undefined
}

async function forceSubtitleReload(run: TranslateRun, reload: CaptionReload): Promise<void> {
  if (run.aborted || reload.aborted) return

  const reloadSession = run.session
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
  if (run.aborted || reload.aborted || reloadSession !== run.session) return

  reload.captionButtonTurnedOff = undefined
  if (run.active) button.click()
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

function startRenderLoop(run: TranslateRun): void {
  if (run.aborted || run.animationFrameId !== undefined) return

  const render = () => {
    if (run.aborted) return

    const video = document.querySelector('video')
    if (run.active && run.session && video) {
      const currentTimeMs = video.currentTime * 1000
      run.renderer?.render(
        run.session.translatedCues,
        currentTimeMs,
        run.session.pendingSegmentAt(currentTimeMs)?.text,
      )
    }
    run.animationFrameId = window.requestAnimationFrame(render)
  }

  run.animationFrameId = window.requestAnimationFrame(render)
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

function createSession(run: TranslateRun, settings: ExtensionSettings): void {
  run.session?.stop()
  run.renderer?.clear()
  const nextSession = new YoutubeSubtitleSession(settings, createRuntimeTranslatorClient())
  run.session = nextSession

  nextSession.fatalErrorHandler = (error: string) => {
    if (run.aborted) return
    showStatusOverlay(chrome.i18n.getMessage('aiTranslateDetail', String(error)))
    // Per spec: do not restore native captions on fatal error
    teardownAiTranslate(run)
  }

  nextSession.windowFailedHandler = (error: string) => {
    if (run.aborted) return
    showStatusOverlay(chrome.i18n.getMessage('aiTranslateDetail', String(error)))
  }

  run.renderer = new SubtitleOverlayRenderer()
}

function readVideoId(): string {
  return parseYouTubeVideoId(new URL(location.href)) ?? ''
}

async function loadSettingsForActivation(
  run: TranslateRun,
): Promise<ExtensionSettings | undefined> {
  const response = await sendMessage<SettingsResponse>({
    type: 'GET_SETTINGS',
  })
  if (run.aborted) return undefined
  if (!response.ok) {
    showStatusOverlay(chrome.i18n.getMessage('aiTranslateDetail', response.error))
    return undefined
  }

  return response.settings
}

const ACTIVATION_RETRY_DELAY_MS = 500
const ACTIVATION_RETRY_MAX_ATTEMPTS = 20

function startActivation(): TranslateRun {
  currentRun?.dispose()
  const run = new TranslateRun()
  currentRun = run
  return run
}

async function retryStoredStateActivation(
  settings: ExtensionSettings,
  run: TranslateRun,
  attempt = 0,
): Promise<void> {
  const availability = await getCurrentCaptionAvailability()
  if (run.aborted) return

  if (availability === 'available') {
    await activateAiTranslate(settings, false, availability, run)
    return
  }

  if (availability === 'unavailable' || attempt === ACTIVATION_RETRY_MAX_ATTEMPTS) {
    deactivateAiTranslate()
    void syncTranslateToggle()
    return
  }

  run.retryTimeoutId = window.setTimeout(() => {
    run.retryTimeoutId = undefined
    if (run.aborted) return
    void retryStoredStateActivation(settings, run, attempt + 1)
  }, ACTIVATION_RETRY_DELAY_MS)
}

async function applyStoredEnabledState(): Promise<void> {
  const run = startActivation()
  const response = await sendMessage<SettingsResponse>({
    type: 'GET_SETTINGS',
  })
  if (run.aborted || !response.ok) return

  if (response.settings.enabled) {
    void retryStoredStateActivation(response.settings, run)
  }
}

function boot(): void {
  listenForCaptionCapture()
  listenForPlayback()
  listenForNavigation()
  listenForMainVideoLoads(() => {
    void syncTranslateToggle()
    const run = currentRun
    if (!run || run.aborted || !run.active) void applyStoredEnabledState()
  })
  listenForSettingsChanges()
  injectTranslateToggle({
    isActive: () => {
      const run = currentRun
      return !!run && !run.aborted && run.active
    },
    onActivateRequest: activateAiTranslate,
    onDeactivateRequest: deactivateAiTranslate,
  })
  void applyStoredEnabledState()

  window.addEventListener('pagehide', () => {
    const run = currentRun
    if (!run || run.aborted) return
    run.session?.stop()
  })
}

boot()
