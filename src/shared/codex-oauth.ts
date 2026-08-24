export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const DEVICE_USER_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode'
export const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token'
export const CODEX_VERIFICATION_URI = 'https://auth.openai.com/codex/device'
export const DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback'
const DEVICE_FLOW_TIMEOUT_MS = 15 * 60 * 1_000
const DEFAULT_POLL_INTERVAL_SECONDS = 5

export interface DeviceCode {
  deviceAuthId: string
  userCode: string
  intervalSeconds: number
}

export interface DeviceAuthorization {
  authorizationCode: string
  codeVerifier: string
}

export interface CodexTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId: string
}

export class CodexOAuthHttpError extends Error {
  override name = 'CodexOAuthHttpError'

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export async function requestDeviceCode(signal?: AbortSignal): Promise<DeviceCode> {
  const response = await fetch(DEVICE_USER_CODE_URL, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  })

  if (!response.ok) {
    throw await createResponseError(response)
  }

  const json = (await response.json()) as {
    device_auth_id?: unknown
    user_code?: unknown
    interval?: unknown
  }
  if (typeof json.device_auth_id !== 'string' || typeof json.user_code !== 'string') {
    throw new Error('Codex device code response is missing required fields')
  }

  const interval = json.interval ?? DEFAULT_POLL_INTERVAL_SECONDS
  const intervalSeconds =
    typeof interval === 'number' || typeof interval === 'string' ? Number(interval) : Number.NaN
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error('Codex device code response has an invalid interval')
  }

  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    intervalSeconds,
  }
}

export async function pollDeviceAuthorization(
  { deviceAuthId, userCode, intervalSeconds }: DeviceCode,
  signal?: AbortSignal,
): Promise<DeviceAuthorization> {
  const deadline = Date.now() + DEVICE_FLOW_TIMEOUT_MS
  let interval = intervalSeconds

  while (Date.now() < deadline) {
    const response = await fetch(DEVICE_TOKEN_URL, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    })

    if (response.ok) {
      const json = (await response.json()) as {
        authorization_code?: unknown
        code_verifier?: unknown
      }
      if (typeof json.authorization_code !== 'string' || typeof json.code_verifier !== 'string') {
        throw new Error('Codex device authorization response is missing required fields')
      }
      return { authorizationCode: json.authorization_code, codeVerifier: json.code_verifier }
    }

    if (response.status !== 403 && response.status !== 404) {
      const body = await response.text()
      const errorCode = extractErrorCode(body)
      if (errorCode === 'slow_down') {
        interval += 5
      } else if (errorCode !== 'deviceauth_authorization_pending') {
        throw new CodexOAuthHttpError(
          `Codex OAuth request failed: ${response.status} ${body}`,
          response.status,
        )
      }
    }

    if (Date.now() >= deadline) break
    await sleep(interval * 1_000, signal)
  }

  throw new Error('Codex device authorization timed out')
}

export async function exchangeDeviceCode(
  authorizationCode: string,
  codeVerifier: string,
  signal?: AbortSignal,
): Promise<CodexTokens> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: DEVICE_REDIRECT_URI,
    }),
  })

  return await parseTokens(response)
}

export async function refreshCodexToken(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<CodexTokens> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  })

  return await parseTokens(response)
}

export function extractAccountId(accessToken: string): string | null {
  try {
    const payload = accessToken.split('.')[1]
    if (!payload) return null
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
    const json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
    const auth = json['https://api.openai.com/auth']
    if (!auth || typeof auth !== 'object') return null
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id
    return typeof accountId === 'string' ? accountId : null
  } catch {
    return null
  }
}

async function parseTokens(response: Response): Promise<CodexTokens> {
  if (!response.ok) {
    throw await createResponseError(response)
  }

  const json = (await response.json()) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  }
  if (
    typeof json.access_token !== 'string' ||
    typeof json.refresh_token !== 'string' ||
    typeof json.expires_in !== 'number' ||
    !Number.isFinite(json.expires_in)
  ) {
    throw new Error('Codex token response is missing required fields')
  }

  const accountId = extractAccountId(json.access_token)

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1_000,
    accountId: accountId ?? '',
  }
}

function extractErrorCode(body: string): string | undefined {
  try {
    const json = JSON.parse(body) as { error?: unknown }
    if (typeof json.error === 'string') return json.error
    if (json.error && typeof json.error === 'object') {
      const code = (json.error as { code?: unknown }).code
      return typeof code === 'string' ? code : undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

async function createResponseError(response: Response): Promise<CodexOAuthHttpError> {
  return new CodexOAuthHttpError(
    `Codex OAuth request failed: ${response.status} ${await response.text()}`,
    response.status,
  )
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
