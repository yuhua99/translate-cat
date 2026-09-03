import type { ProviderSecret, ProviderType } from './types'
import { PROVIDER_SECRETS_KEY } from '../../shared/messages'

export interface ProviderStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export interface ProviderStores {
  sync: ProviderStorageArea
  local: ProviderStorageArea
}

export async function getProviderSecret(
  storage: ProviderStorageArea,
  providerType: ProviderType,
): Promise<ProviderSecret> {
  const stored = await storage.get(PROVIDER_SECRETS_KEY)
  const secrets =
    (stored[PROVIDER_SECRETS_KEY] as Partial<Record<ProviderType, ProviderSecret>> | undefined) ??
    {}
  return secrets[providerType] ?? {}
}

export function hasCredentials(providerType: ProviderType, secret: ProviderSecret): boolean {
  return providerType === 'codex' ? Boolean(secret.codexAuth) : Boolean(secret.apiKey)
}

export async function setProviderSecret(
  storage: ProviderStorageArea,
  providerType: ProviderType,
  secret: ProviderSecret,
): Promise<void> {
  const stored = await storage.get(PROVIDER_SECRETS_KEY)
  const secrets =
    (stored[PROVIDER_SECRETS_KEY] as Partial<Record<ProviderType, ProviderSecret>> | undefined) ??
    {}
  await storage.set({
    [PROVIDER_SECRETS_KEY]: { ...secrets, [providerType]: secret },
  })
}
