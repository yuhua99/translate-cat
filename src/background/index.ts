import { testProviderConnection } from './providers/provider-test'
import {
  getProviderConfig,
  getProviderSecret,
  setProviderConfig,
  setProviderSecret,
} from './providers/storage'
import { translateSubtitleMessage } from './providers/subtitle-translation'
import { getSettings, setSettings } from './settings-storage'
import type { ExtensionMessage, ExtensionResponse } from '../shared/messages'

chrome.runtime.onInstalled.addListener(() => {
  console.info('translate cat installed')
})

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  void (async () => {
    try {
      if (message.type === 'GET_SETTINGS') {
        sendResponse({
          ok: true,
          settings: await getSettings(chrome.storage.sync),
        } satisfies ExtensionResponse)
        return
      }

      if (message.type === 'SET_SETTINGS') {
        await setSettings(chrome.storage.sync, message.settings)
        sendResponse({ ok: true, settings: message.settings } satisfies ExtensionResponse)
        return
      }

      if (message.type === 'GET_PROVIDER_CONFIG') {
        sendResponse({
          ok: true,
          config: await getProviderConfig(chrome.storage.sync, message.providerType),
        } satisfies ExtensionResponse)
        return
      }

      if (message.type === 'SET_PROVIDER_CONFIG') {
        await setProviderConfig(chrome.storage.sync, message.config)
        sendResponse({ ok: true, message: 'provider config saved' } satisfies ExtensionResponse)
        return
      }

      if (message.type === 'SET_PROVIDER_SECRET') {
        await setProviderSecret(chrome.storage.local, message.providerType, message.secret)
        sendResponse({ ok: true, message: 'provider secret saved' } satisfies ExtensionResponse)
        return
      }

      if (message.type === 'TEST_PROVIDER') {
        sendResponse(
          (await testProviderConnection(
            message.config,
            message.secret,
          )) satisfies ExtensionResponse,
        )
        return
      }

      if (message.type === 'VALIDATE_ACTIVE_PROVIDER') {
        const settings = await getSettings(chrome.storage.sync)
        const config = await getProviderConfig(chrome.storage.sync, settings.providerType)
        const secret = await getProviderSecret(chrome.storage.local, settings.providerType)
        if (!secret.apiKey) {
          sendResponse({
            ok: false,
            error: `Missing API key for ${settings.providerType}`,
          } satisfies ExtensionResponse)
          return
        }
        if (!config.model) {
          sendResponse({
            ok: false,
            error: `Missing model for ${settings.providerType}`,
          } satisfies ExtensionResponse)
          return
        }
        sendResponse({ ok: true, message: 'ok' } satisfies ExtensionResponse)
        return
      }

      if (message.type === 'TRANSLATE_SUBTITLE_AI_PROVIDER') {
        sendResponse(
          (await translateSubtitleMessage(message, {
            sync: chrome.storage.sync,
            local: chrome.storage.local,
          })) satisfies ExtensionResponse,
        )
        return
      }

      if (message.type === 'PING') {
        sendResponse({ ok: true, message: 'pong' } satisfies ExtensionResponse)
        return
      }

      sendResponse({
        ok: false,
        error: `Unknown message type: ${String((message as { type?: string }).type)}`,
      } satisfies ExtensionResponse)
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies ExtensionResponse)
    }
  })()

  return true
})
