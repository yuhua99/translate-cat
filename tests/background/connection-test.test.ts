import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'

interface MessageListener {
  (
    message: unknown,
    sender: { documentId?: string },
    sendResponse: (response: unknown) => void,
  ): boolean
}

let messageListener: MessageListener | undefined
let request: Request | undefined
const originalFetch = globalThis.fetch
const chromeGlobal = globalThis as typeof globalThis & { chrome?: unknown }
const originalChrome = chromeGlobal.chrome

chromeGlobal.chrome = {
  contextMenus: {
    removeAll() {},
    create() {},
    onClicked: { addListener() {} },
  },
  i18n: { getMessage: () => '' },
  runtime: {
    onConnect: { addListener() {} },
    onInstalled: { addListener() {} },
    onMessage: {
      addListener(listener: MessageListener) {
        messageListener = listener
      },
    },
  },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    sync: { get: async () => ({}), set: async () => {} },
  },
  tabs: { sendMessage: async () => {} },
}

await import('../../src/background/index')

beforeEach(() => {
  request = undefined
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init)
    return Response.json({ choices: [{ message: { content: 'OK' } }] })
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

afterAll(() => {
  if (originalChrome === undefined) delete chromeGlobal.chrome
  else chromeGlobal.chrome = originalChrome
})

async function testProvider(sender: { documentId?: string }): Promise<Request> {
  if (!messageListener) throw new Error('TEST_PROVIDER listener was not registered')

  let response: unknown
  await new Promise<void>((resolve) => {
    messageListener(
      {
        type: 'TEST_PROVIDER',
        config: { type: 'opencodeZen', model: 'gpt-5.6-luna' },
        secret: { apiKey: 'key' },
      },
      sender,
      (value) => {
        response = value
        resolve()
      },
    )
  })

  expect(response).toEqual({ ok: true })
  expect(request).toBeDefined()
  return request as Request
}

describe('TEST_PROVIDER connection context', () => {
  test('uses a UUID session when sender has no documentId', async () => {
    const providerRequest = await testProvider({})

    expect(providerRequest.headers.get('x-opencode-session')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  test('retains sender documentId as the session', async () => {
    const providerRequest = await testProvider({ documentId: 'document-session-123' })

    expect(providerRequest.headers.get('x-opencode-session')).toBe('document-session-123')
  })
})
