export class ProviderHttpError extends Error {
  override name = 'ProviderHttpError'
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export class ProviderJsonParseError extends Error {
  override name = 'ProviderJsonParseError'
}

export class ProviderNetworkError extends Error {
  override name = 'ProviderNetworkError'
}
