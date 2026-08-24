import { afterEach, describe, expect, test } from 'bun:test'
import {
  CLIENT_ID,
  DEVICE_REDIRECT_URI,
  DEVICE_TOKEN_URL,
  DEVICE_USER_CODE_URL,
  TOKEN_URL,
  exchangeDeviceCode,
  extractAccountId,
  pollDeviceAuthorization,
  refreshCodexToken,
  requestDeviceCode,
} from '../../src/shared/codex-oauth'

const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalSetTimeout
})

function createAccessToken(accountId = 'account-123'): string {
  const payload = btoa(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  )
  return `header.${payload}.signature`
}

function useImmediateTimers(delays: number[]): void {
  globalThis.setTimeout = ((callback: () => void, ms?: number) => {
    delays.push(ms ?? 0)
    callback()
    return 0
  }) as typeof setTimeout
}

describe('Codex OAuth', () => {
  test('requests and normalizes a device code', async () => {
    let request: Request | undefined
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init)
      return Response.json({ device_auth_id: 'device-id', user_code: 'ABCD-EFGH', interval: '7' })
    }

    await expect(requestDeviceCode()).resolves.toEqual({
      deviceAuthId: 'device-id',
      userCode: 'ABCD-EFGH',
      intervalSeconds: 7,
    })
    expect(request?.url).toBe(DEVICE_USER_CODE_URL)
    expect(await request?.json()).toEqual({ client_id: CLIENT_ID })
  })

  test('polls pending authorization until it completes', async () => {
    const delays: number[] = []
    useImmediateTimers(delays)
    let calls = 0
    let requestUrl: string | undefined
    globalThis.fetch = async (input) => {
      requestUrl = String(input)
      calls += 1
      return calls === 1
        ? Response.json({ error: 'deviceauth_authorization_pending' }, { status: 400 })
        : Response.json({ authorization_code: 'authorization-code', code_verifier: 'verifier' })
    }

    await expect(
      pollDeviceAuthorization({ deviceAuthId: 'device', userCode: 'code', intervalSeconds: 5 }),
    ).resolves.toEqual({ authorizationCode: 'authorization-code', codeVerifier: 'verifier' })
    expect(requestUrl).toBe(DEVICE_TOKEN_URL)
    expect(delays).toEqual([5_000])
  })

  test('increases the polling interval after slow_down', async () => {
    const delays: number[] = []
    useImmediateTimers(delays)
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      if (calls === 1) return Response.json({ error: { code: 'slow_down' } }, { status: 400 })
      if (calls === 2) return new Response('', { status: 403 })
      return Response.json({ authorization_code: 'authorization-code', code_verifier: 'verifier' })
    }

    await pollDeviceAuthorization({ deviceAuthId: 'device', userCode: 'code', intervalSeconds: 5 })
    expect(delays).toEqual([10_000, 10_000])
  })

  test('treats 403 and 404 responses as pending', async () => {
    const delays: number[] = []
    useImmediateTimers(delays)
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      if (calls === 1) return new Response('', { status: 403 })
      if (calls === 2) return new Response('', { status: 404 })
      return Response.json({ authorization_code: 'authorization-code', code_verifier: 'verifier' })
    }

    await expect(
      pollDeviceAuthorization({ deviceAuthId: 'device', userCode: 'code', intervalSeconds: 0 }),
    ).resolves.toEqual({ authorizationCode: 'authorization-code', codeVerifier: 'verifier' })
    expect(delays).toEqual([0, 0])
  })

  test('throws on a non-pending polling failure', async () => {
    globalThis.fetch = async () => Response.json({ error: 'access_denied' }, { status: 400 })

    await expect(
      pollDeviceAuthorization({ deviceAuthId: 'device', userCode: 'code', intervalSeconds: 0 }),
    ).rejects.toThrow('Codex OAuth request failed: 400')
  })

  test('exchanges the device authorization code', async () => {
    let request: Request | undefined
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init)
      return Response.json({
        access_token: createAccessToken(),
        refresh_token: 'refresh-token',
        expires_in: 3600,
      })
    }

    const tokens = await exchangeDeviceCode('authorization-code', 'verifier')
    const body = new URLSearchParams(await request?.text())
    expect(request?.url).toBe(TOKEN_URL)
    expect(request?.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: 'authorization-code',
      code_verifier: 'verifier',
      redirect_uri: DEVICE_REDIRECT_URI,
    })
    expect(tokens).toMatchObject({ refreshToken: 'refresh-token', accountId: 'account-123' })
  })

  test('refreshes a Codex token', async () => {
    let request: Request | undefined
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init)
      return Response.json({
        access_token: createAccessToken(),
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      })
    }

    await expect(refreshCodexToken('refresh-token')).resolves.toMatchObject({
      refreshToken: 'new-refresh-token',
      accountId: 'account-123',
    })
    const body = new URLSearchParams(await request?.text())
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token',
      client_id: CLIENT_ID,
    })
  })

  test('extracts a ChatGPT account ID and rejects malformed tokens', () => {
    expect(extractAccountId(createAccessToken('account-456'))).toBe('account-456')
    expect(extractAccountId('not-a-jwt')).toBeNull()
    expect(extractAccountId('header.invalid.signature')).toBeNull()
    expect(extractAccountId('header.e30.signature')).toBeNull()
  })
})
