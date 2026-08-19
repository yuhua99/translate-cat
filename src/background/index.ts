import { createProvider } from './providers/factory'
import {
  getProviderConfig,
  getProviderSecret,
  setProviderConfig,
  setProviderSecret,
} from './providers/storage'
import { translateSubtitleMessage, translateTextMessage } from './providers/subtitle-translation'
import { getSettings, setSettings } from './settings-storage'
import type { ExtensionMessage, ExtensionResponse } from '../shared/messages'

chrome.runtime.onInstalled.addListener(() => {
  console.info('translate cat installed')
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'translate-cat-selection',
      title: 'Translate with translate cat',
      contexts: ['selection'],
    })
  })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'translate-cat-selection' || info.frameId !== 0 || !tab?.id) return
  void chrome.tabs
    .sendMessage(tab.id, { type: 'CONTEXT_MENU_TRANSLATE' } satisfies ExtensionMessage)
    .catch(() => {})
})

const pendingTranslations = new Map<string, AbortController>()

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
        sendResponse({ ok: true } satisfies ExtensionResponse)
        return
      }

      if (message.type === 'SET_PROVIDER_SECRET') {
        await setProviderSecret(chrome.storage.local, message.providerType, message.secret)
        sendResponse({ ok: true } satisfies ExtensionResponse)
        return
      }

      if (message.type === 'TEST_PROVIDER') {
        const secret = message.secret.apiKey
          ? message.secret
          : await getProviderSecret(chrome.storage.local, message.config.type)
        sendResponse(
          (await createProvider(
            message.config,
            secret,
          ).testConnection()) satisfies ExtensionResponse,
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
        sendResponse({ ok: true } satisfies ExtensionResponse)
        return
      }

      if (message.type === 'TRANSLATE_SUBTITLE_AI_PROVIDER') {
        const { requestId } = message
        const controller = requestId ? new AbortController() : undefined
        if (requestId && controller) pendingTranslations.set(requestId, controller)
        try {
          sendResponse(
            (await translateSubtitleMessage(
              message,
              { sync: chrome.storage.sync, local: chrome.storage.local },
              controller?.signal,
            )) satisfies ExtensionResponse,
          )
        } finally {
          if (requestId) pendingTranslations.delete(requestId)
        }
        return
      }

      if (message.type === 'CANCEL_TRANSLATION') {
        const controller = pendingTranslations.get(message.requestId)
        if (controller) {
          controller.abort()
          pendingTranslations.delete(message.requestId)
          sendResponse({ ok: true } satisfies ExtensionResponse)
        } else {
          sendResponse({ ok: true } satisfies ExtensionResponse)
        }
        return
      }

      if (message.type === 'TRANSLATE_TEXT') {
        sendResponse(
          (await translateTextMessage(message.text, {
            sync: chrome.storage.sync,
            local: chrome.storage.local,
          })) satisfies ExtensionResponse,
        )
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
