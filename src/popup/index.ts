import {
  DEFAULT_SETTINGS,
  type ExtensionMessage,
  type ExtensionResponse,
  type ExtensionSettings,
  type ProviderConfigResponse,
  type ProviderTestResponse,
  type SettingsResponse,
} from '../shared/messages'
import type { ProviderConfig, ProviderSecret, ProviderType } from '../background/providers/types'
import { ALL_PROVIDER_TYPES, getProviderLabel, getProviderModels } from '../shared/providers'

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
const providerTypeInput = requiredElement<HTMLSelectElement>('#provider-type')
const providerModelPresetInput = requiredElement<HTMLSelectElement>('#provider-model-preset')
const customModelRow = requiredElement<HTMLElement>('#custom-model-row')
const providerModelInput = requiredElement<HTMLInputElement>('#provider-model')
const providerApiKeyInput = requiredElement<HTMLInputElement>('#provider-api-key')
const saveButton = requiredElement<HTMLButtonElement>('#save')
const status = requiredElement<HTMLParagraphElement>('#status')
let currentSettings: ExtensionSettings = DEFAULT_SETTINGS
let savedModel = ''
let savedApiKey = ''

function sendMessage<TResponse extends ExtensionResponse>(
  message: ExtensionMessage,
): Promise<TResponse> {
  return chrome.runtime.sendMessage(message)
}

function getProviderType(): ProviderType {
  return providerTypeInput.value as ProviderType
}

function getSelectedModel(): string {
  if (providerModelPresetInput.value === CUSTOM_MODEL_VALUE) {
    return providerModelInput.value.trim()
  }
  return providerModelPresetInput.value
}

function renderModelPresets(providerType: ProviderType, selected?: string): void {
  const presets = getProviderModels(providerType)
  const isCustom = Boolean(selected && !presets.includes(selected))
  const options = presets.map((model) => {
    const option = document.createElement('option')
    option.value = model
    option.textContent = model
    option.selected = model === selected
    return option
  })
  const customOption = document.createElement('option')
  customOption.value = CUSTOM_MODEL_VALUE
  customOption.textContent = 'Custom model'
  customOption.selected = isCustom

  providerModelPresetInput.replaceChildren(...options, customOption)
  providerModelInput.value = isCustom && selected ? selected : ''
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
    getProviderType() !== currentSettings.providerType ||
    getSelectedModel() !== savedModel ||
    providerApiKeyInput.value.trim() !== savedApiKey
  saveButton.hidden = !dirty
}

function renderSettings(settings: ExtensionSettings): void {
  currentSettings = settings
  renderTargetLanguages(settings.targetLanguage)
  renderProviderTypes(settings.providerType)
  renderModelPresets(settings.providerType)
}

function renderProviderConfig(response: ProviderConfigResponse): void {
  if (!response.ok) return
  savedModel = response.config.model
  renderProviderTypes(response.config.type)
  renderModelPresets(response.config.type, response.config.model)
  updateSaveRequired() // called once, after model is known
}

async function loadSettings(): Promise<void> {
  const response = await sendMessage<SettingsResponse>({ type: 'GET_SETTINGS' })
  if (!response.ok) {
    renderSettings(DEFAULT_SETTINGS)
    status.textContent = response.error
    return
  }

  renderSettings(response.settings)
  renderProviderConfig(
    await sendMessage<ProviderConfigResponse>({
      type: 'GET_PROVIDER_CONFIG',
      providerType: response.settings.providerType,
    }),
  )
}

async function saveSettings(): Promise<void> {
  saveButton.hidden = true
  status.textContent = 'Testing provider...'

  // snapshot form values so in-flight edits don't leak into saves
  const providerType = getProviderType()
  const model = getSelectedModel()
  const apiKey = providerApiKeyInput.value.trim()
  const config: ProviderConfig = { type: providerType, model }
  const secret: ProviderSecret = { apiKey: apiKey || undefined }

  try {
    const testResponse = await sendMessage<ProviderTestResponse>({
      type: 'TEST_PROVIDER',
      config,
      secret,
    })

    if (!testResponse.ok) {
      status.textContent = testResponse.error
      return
    }

    const settings: ExtensionSettings = {
      ...currentSettings,
      targetLanguage: targetLanguageInput.value,
      providerType,
    }

    const settingsResponse = await sendMessage<SettingsResponse>({ type: 'SET_SETTINGS', settings })
    if (!settingsResponse.ok) {
      status.textContent = settingsResponse.error
      return
    }

    const configResponse = await sendMessage({
      type: 'SET_PROVIDER_CONFIG',
      config,
    })
    if (!configResponse.ok) {
      status.textContent = configResponse.error
      return
    }

    if (secret.apiKey) {
      const secretResponse = await sendMessage({
        type: 'SET_PROVIDER_SECRET',
        providerType,
        secret,
      })
      if (!secretResponse.ok) {
        status.textContent = secretResponse.error
        return
      }
    }

    currentSettings = settings
    savedModel = model
    savedApiKey = apiKey
    status.textContent = 'Saved'
    updateSaveRequired()
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error)
  } finally {
    updateSaveRequired()
  }
}

providerTypeInput.addEventListener('change', () => {
  renderModelPresets(getProviderType())
  updateSaveRequired()
})

providerModelPresetInput.addEventListener('change', () => {
  syncCustomModelVisibility()
  updateSaveRequired()
})

for (const input of [providerApiKeyInput, providerModelInput, targetLanguageInput]) {
  input.addEventListener('input', updateSaveRequired)
}

saveButton.addEventListener('click', () => {
  void saveSettings()
})

void loadSettings()
