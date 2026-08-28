// Sanitized failure surface for Metered credential requests. The message is a
// fixed string with no interpolation of the request URL or underlying error —
// the URL carries the API key as a query parameter (Metered's API design, not
// ours), so it must never reach logs or be relayed back to a client.
export class TurnCredentialFetchError extends Error {
  readonly status?: number;

  constructor(status?: number) {
    super("Failed to fetch TURN credentials from Metered");
    this.name = "TurnCredentialFetchError";
    this.status = status;
  }
}

// `credentials_url` is resolved once at startup in index.mts from the
// required METERED_CREDENTIALS_URL env var (e.g.
// "https://stampatron.metered.live/api/v1/turn/credentials"). Taken as a
// parameter here rather than read from process.env directly, so this
// function stays account-agnostic and unit-testable.
export async function fetch_metered_ice_servers(
  credentials_url: string,
  api_key: string,
): Promise<unknown> {
  const url = `${credentials_url}?apiKey=${encodeURIComponent(api_key)}`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    // Network-level failure. The original error may embed `url` (and
    // therefore the key) — never rethrow or log it here.
    throw new TurnCredentialFetchError();
  }

  if (!response.ok) {
    throw new TurnCredentialFetchError(response.status);
  }

  try {
    return await response.json();
  } catch {
    throw new TurnCredentialFetchError(response.status);
  }
}
