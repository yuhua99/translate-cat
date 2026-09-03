import {
  DEFAULT_SETTINGS,
  type ExtensionMessage,
  type ExtensionResponse,
  type ExtensionSettings,
  type ProviderAuthStatusResponse,
  type ProviderTestResponse,
  type MessageResponse,
  type SettingsResponse,
} from '../shared/messages'
import type { ProviderConfig, ProviderSecret, ProviderType } from '../background/providers/types'
import { localizePage } from '../shared/i18n'
import {
  ALL_PROVIDER_TYPES,
  getDefaultModel,
  getProviderLabel,
  getProviderModels,
} from '../shared/providers'

localizePage()

const TARGET_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
]

const CUSTOM_MODEL_VALUE = '__custom__'

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Popup DOM missing required element: ${selector}`)
  return element
}

const targetLanguageInput = requiredElement<HTMLSelectElement>('#target-language')
const selectionEnabledInput = requiredElement<HTMLInputElement>('#selection-enabled')
const providerTypeInput = requiredElement<HTMLSelectElement>('#provider-type')
const providerModelPresetInput = requiredElement<HTMLSelectElement>('#provider-model-preset')
const customModelRow = requiredElement<HTMLElement>('#custom-model-row')
const providerModelInput = requiredElement<HTMLInputElement>('#provider-model')
const providerApiKeyRow = requiredElement<HTMLElement>('#provider-api-key-row')
const providerApiKeyInput = requiredElement<HTMLInputElement>('#provider-api-key')
const codexAuthRow = requiredElement<HTMLElement>('#codex-auth-row')
const codexSignInButton = requiredElement<HTMLButtonElement>('#codex-sign-in')
const codexSignInLabel = requiredElement<HTMLSpanElement>('#codex-sign-in .codex-chip__label')
const codexSignOutLabel = requiredElement<HTMLSpanElement>(
  '#codex-sign-in .codex-chip__sign-out-label',
)
const saveButton = requiredElement<HTMLButtonElement>('#save')
const status = requiredElement<HTMLParagraphElement>('#status')
let currentSettings: ExtensionSettings = DEFAULT_SETTINGS
let savedApiKey = ''
let codexSignedIn = false
let statusClearTimeout: number | undefined

function sendMessage<TResponse extends ExtensionResponse>(
  message: ExtensionMessage,
): Promise<TResponse> {
  return chrome.runtime.sendMessage(message)
}

function setStatus(text: string, kind: 'success' | 'error' | 'neutral' = 'neutral'): void {
  if (statusClearTimeout !== undefined) {
    window.clearTimeout(statusClearTimeout)
    statusClearTimeout = undefined
  }

  status.textContent = text
  status.classList.toggle('success', kind === 'success')
  status.classList.toggle('error', kind === 'error')
  status.classList.toggle('lcd-inverted', kind !== 'neutral')

  if (kind !== 'neutral') {
    statusClearTimeout = window.setTimeout(() => {
      status.textContent = ''
      status.classList.remove('success', 'error', 'lcd-inverted')
      statusClearTimeout = undefined
    }, 5000)
  }
}

function getProviderType(): ProviderType {
  return providerTypeInput.value as ProviderType
}

function isOAuthProvider(providerType = getProviderType()): boolean {
  return providerType === 'codex'
}

function setCodexSignInButton(signedIn: boolean): void {
  codexSignedIn = signedIn
  codexSignInButton.classList.toggle('is-signed-in', signedIn)
  codexSignInButton.setAttribute(
    'aria-label',
    chrome.i18n.getMessage(signedIn ? 'signOut' : 'signIn'),
  )
  const label = chrome.i18n.getMessage(signedIn ? 'popupSignedIn' : 'signIn')
  const signOutLabel = signedIn ? chrome.i18n.getMessage('signOut') : ''
  codexSignInLabel.textContent = label
  codexSignOutLabel.textContent = signOutLabel
}

function syncProviderAuth(): void {
  const isOAuth = isOAuthProvider()
  providerApiKeyRow.hidden = isOAuth
  codexAuthRow.hidden = !isOAuth
  setCodexSignInButton(false)
  if (isOAuth) void updateProviderAuthStatus()
}

async function updateProviderAuthStatus(): Promise<void> {
  const providerType = getProviderType()
  if (!isOAuthProvider(providerType)) return

  try {
    const response = await sendMessage<ProviderAuthStatusResponse>({
      type: 'GET_PROVIDER_AUTH_STATUS',
      providerType,
    } satisfies ExtensionMessage)
    if (!response.ok || getProviderType() !== providerType) return
    setCodexSignInButton(response.signedIn)
  } catch {
    // Fire-and-forget status check: on failure the button keeps the signed-out
    // default set by syncProviderAuth, so the rejection is safe to swallow.
  }
}

function getSelectedModel(): string {
  if (providerModelPresetInput.value === CUSTOM_MODEL_VALUE) {
    return providerModelInput.value.trim()
  }
  return providerModelPresetInput.value
}

function validateCustomModel(): boolean {
  providerModelInput.value = providerModelInput.value.trim()
  if (!providerModelInput.required || providerModelInput.validity.valid) return true

  providerModelInput.reportValidity()
  return false
}

function modelFor(type: ProviderType): string {
  return type === currentSettings.provider.type
    ? currentSettings.provider.model
    : getDefaultModel(type)
}

function renderModelPresets(providerType: ProviderType, selected: string): void {
  const presets = getProviderModels(providerType)
  const isCustom = !presets.includes(selected)
  const options = presets.map((model) => {
    const option = document.createElement('option')
    option.value = model
    option.textContent = model
    option.selected = model === selected
    return option
  })
  const customOption = document.createElement('option')
  customOption.value = CUSTOM_MODEL_VALUE
  customOption.textContent = chrome.i18n.getMessage('popupCustomModelOption')
  customOption.selected = isCustom

  providerModelPresetInput.replaceChildren(...options, customOption)
  providerModelInput.value = isCustom ? selected : ''
  syncCustomModelVisibility()
}

function syncCustomModelVisibility(): void {
  const isCustom = providerModelPresetInput.value === CUSTOM_MODEL_VALUE
  customModelRow.hidden = !isCustom
  providerModelInput.required = isCustom
}

function renderProviderTypes(selected: ProviderType): void {
  const options = ALL_PROVIDER_TYPES.map((value) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = getProviderLabel(value)
    option.selected = value === selected
    return option
  })
  providerTypeInput.replaceChildren(...options)
}

function renderTargetLanguages(selected: string): void {
  const options = TARGET_LANGUAGES.map(({ value, label }) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    option.selected = value === selected
    return option
  })
  targetLanguageInput.replaceChildren(...options)
}

function updateSaveRequired(): void {
  const dirty =
    targetLanguageInput.value !== currentSettings.targetLanguage ||
    selectionEnabledInput.checked !== currentSettings.selectionEnabled ||
    getProviderType() !== currentSettings.provider.type ||
    getSelectedModel() !== currentSettings.provider.model ||
    (!isOAuthProvider() && providerApiKeyInput.value.trim() !== savedApiKey)
  saveButton.hidden = !dirty
}

function handleFormChange(): void {
  if (status.classList.contains('success') || status.classList.contains('error')) setStatus('')
  updateSaveRequired()
}

function renderSettings(settings: ExtensionSettings): void {
  currentSettings = settings
  renderTargetLanguages(settings.targetLanguage)
  selectionEnabledInput.checked = settings.selectionEnabled
  renderProviderTypes(settings.provider.type)
  renderModelPresets(settings.provider.type, settings.provider.model)
  syncProviderAuth()
  updateSaveRequired() // called once, after model is known
}

async function loadSettings(): Promise<void> {
  const response = await sendMessage<SettingsResponse>({ type: 'GET_SETTINGS' })
  if (!response.ok) {
    renderSettings(DEFAULT_SETTINGS)
    setStatus(response.error, 'error')
    return
  }

  renderSettings(response.settings)
}

function getFormSettings(providerType: ProviderType): ExtensionSettings {
  return {
    ...currentSettings,
    targetLanguage: targetLanguageInput.value,
    selectionEnabled: selectionEnabledInput.checked,
    provider: { type: providerType, model: getSelectedModel() },
  }
}

async function persistProviderSettings(settings: ExtensionSettings): Promise<boolean> {
  const response = await sendMessage<MessageResponse>({
    type: 'SET_APP_SETTINGS',
    selectionEnabled: settings.selectionEnabled,
    targetLanguage: settings.targetLanguage,
    provider: settings.provider,
  })
  if (!response.ok) {
    setStatus(response.error, 'error')
    return false
  }

  return true
}

async function saveSettings(): Promise<void> {
  if (!validateCustomModel()) return

  saveButton.hidden = true
  setStatus(chrome.i18n.getMessage('popupTestingProvider'))

  // snapshot form values so in-flight edits don't leak into saves
  const providerType = getProviderType()
  const model = getSelectedModel()
  const isOAuth = isOAuthProvider(providerType)
  const apiKey = isOAuth ? '' : providerApiKeyInput.value.trim()
  const config: ProviderConfig = { type: providerType, model }
  const secret: ProviderSecret = isOAuth ? {} : { apiKey: apiKey || undefined }
  const settings = getFormSettings(providerType)

  try {
    const testResponse = await sendMessage<ProviderTestResponse>({
      type: 'TEST_PROVIDER',
      config,
      secret,
    })

    if (!testResponse.ok) {
      setStatus(testResponse.error, 'error')
      return
    }

    if (!(await persistProviderSettings(settings))) return

    if (!isOAuth && secret.apiKey) {
      const secretResponse = await sendMessage({
        type: 'SET_PROVIDER_SECRET',
        providerType,
        secret,
      })
      if (!secretResponse.ok) {
        setStatus(secretResponse.error, 'error')
        return
      }
    }

    currentSettings = settings
    savedApiKey = apiKey
    setStatus(chrome.i18n.getMessage('popupSaved'), 'success')
    updateSaveRequired()
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    updateSaveRequired()
  }
}

providerTypeInput.addEventListener('change', () => {
  const providerType = getProviderType()
  renderModelPresets(providerType, modelFor(providerType))
  providerApiKeyInput.value = providerType === currentSettings.provider.type ? savedApiKey : ''
  syncProviderAuth()
  handleFormChange()
})

providerModelPresetInput.addEventListener('change', () => {
  syncCustomModelVisibility()
  handleFormChange()
})

for (const input of [providerApiKeyInput, providerModelInput, targetLanguageInput]) {
  input.addEventListener('input', handleFormChange)
}

providerApiKeyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') providerApiKeyInput.blur()
})

selectionEnabledInput.addEventListener('change', handleFormChange)

saveButton.addEventListener('click', () => {
  void saveSettings()
})

async function signInWithChatGPT(): Promise<void> {
  if (!validateCustomModel()) return

  codexSignInButton.disabled = true

  try {
    const providerType = getProviderType()
    const settings = getFormSettings(providerType)

    if (!(await persistProviderSettings(settings))) return
    currentSettings = settings
    savedApiKey = ''
    updateSaveRequired()
    await chrome.tabs.create({ url: chrome.runtime.getURL('codex-auth.html') })
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    codexSignInButton.disabled = false
  }
}

async function signOutOfChatGPT(): Promise<void> {
  codexSignInButton.disabled = true

  try {
    const response = await sendMessage({
      type: 'SET_PROVIDER_SECRET',
      providerType: 'codex',
      secret: {},
    })
    if (!response.ok) {
      setStatus(response.error, 'error')
      return
    }
    await updateProviderAuthStatus()
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    codexSignInButton.disabled = false
  }
}

codexSignInButton.addEventListener('click', () => {
  void (codexSignedIn ? signOutOfChatGPT() : signInWithChatGPT())
})

window.addEventListener('focus', () => {
  void updateProviderAuthStatus()
})

void loadSettings()
