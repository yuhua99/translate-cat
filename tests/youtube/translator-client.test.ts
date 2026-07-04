import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createRuntimeTranslatorClient } from '../../src/youtube/translator-client'
import type { TranslateSubtitleInput } from '../../src/youtube/translator-client'

type SendMessage = (message: unknown) => Promise<unknown>

let sent: unknown[] = []
let sendMessage: SendMessage

const originalChrome = (globalThis as { chrome?: unknown }).chrome

function installChrome(fn: SendMessage): void {
  sendMessage = fn
  ;(globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage: (message: unknown) => {
        sent.push(message)
        return sendMessage(message)
      },
    },
  }
}

beforeEach(() => {
  sent = []
})

afterEach(() => {
  ;(globalThis as { chrome?: unknown }).chrome = originalChrome
})

const input: TranslateSubtitleInput = {
  providerType: 'openai',
  videoId: 'v1',
  track: { trackId: 't1', languageCode: 'en', kind: 'manual' } as never,
  segments: [{ id: 'v1:en::manual:0', text: 'Hello', startMs: 0, endMs: 1000 } as never],
  targetLanguage: 'zh-TW',
}

describe('createRuntimeTranslatorClient', () => {
  test('includes a requestId in the TRANSLATE_SUBTITLE_AI_PROVIDER message', async () => {
    installChrome(async () => ({ ok: true, translations: [] }))
    const client = createRuntimeTranslatorClient()

    await client.translateSubtitle(input, new AbortController().signal)

    expect(sent).toHaveLength(1)
    const msg = sent[0] as { type: string; requestId: string }
    expect(msg.type).toBe('TRANSLATE_SUBTITLE_AI_PROVIDER')
    expect(typeof msg.requestId).toBe('string')
    expect(msg.requestId.length).toBeGreaterThan(0)
  })

  test('aborting in-flight sends CANCEL_TRANSLATION with the same requestId', async () => {
    let resolveTranslate: (value: unknown) => void = () => {}
    installChrome(
      (message) =>
        new Promise((resolve) => {
          if ((message as { type: string }).type === 'TRANSLATE_SUBTITLE_AI_PROVIDER') {
            resolveTranslate = resolve
          } else {
            resolve(undefined)
          }
        }),
    )
    const client = createRuntimeTranslatorClient()
    const controller = new AbortController()

    const pending = client.translateSubtitle(input, controller.signal)
    const translateMsg = sent[0] as { requestId: string }

    controller.abort()

    expect(sent).toHaveLength(2)
    const cancelMsg = sent[1] as { type: string; requestId: string }
    expect(cancelMsg.type).toBe('CANCEL_TRANSLATION')
    expect(cancelMsg.requestId).toBe(translateMsg.requestId)

    resolveTranslate({ ok: false, error: 'aborted', fatal: false })
    await pending
  })

  test('pre-aborted signal returns aborted without sending', async () => {
    installChrome(async () => ({ ok: true, translations: [] }))
    const client = createRuntimeTranslatorClient()
    const controller = new AbortController()
    controller.abort()

    const result = await client.translateSubtitle(input, controller.signal)

    expect(sent).toHaveLength(0)
    expect(result).toEqual({ ok: false, error: 'aborted', fatal: false })
  })
})
