// Sanitized failure surface for Metered credential requests. The message is a
// fixed string with no interpolation of the request URL or underlying error —
// the URL carries the API key as a query parameter (Metered's API design, not
// ours), so it must never reach logs or be relayed back to a client. `reason`
// distinguishes *why* the fetch failed for server-side logging - safe to
// include since it's always one of these fixed literals, never derived from
// the response body or the request itself.
export type TurnCredentialFetchFailureReason =
  "network_error" | "bad_status" | "invalid_json" | "invalid_shape";

export class TurnCredentialFetchError extends Error {
  readonly status?: number;
  readonly reason: TurnCredentialFetchFailureReason;

  constructor(reason: TurnCredentialFetchFailureReason, status?: number) {
    super("Failed to fetch TURN credentials from Metered");
    this.name = "TurnCredentialFetchError";
    this.reason = reason;
    this.status = status;
  }
}

// Mirrors the browser's RTCIceServer shape structurally, without depending
// on the DOM lib (this is a Node service - pulling in "dom" just for this
// one type would be a strange trade). Kept in sync by hand with
// hopdrop-client's identical validation in signaling_protocol.mts - the two
// repos share no code by design, so this duplication is accepted, not
// accidental.
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
  credentialType?: "password";
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function is_ice_server_urls(value: unknown): value is string | string[] {
  if (typeof value === "string") {
    return true;
  }
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string")
  );
}

function is_ice_server(value: unknown): value is IceServer {
  if (!is_record(value) || !is_ice_server_urls(value.urls)) {
    return false;
  }
  if (value.username !== undefined && typeof value.username !== "string") {
    return false;
  }
  if (value.credential !== undefined && typeof value.credential !== "string") {
    return false;
  }
  // "password" is the only credentialType the spec defines - anything else
  // present is treated as invalid rather than silently accepted.
  if (
    value.credentialType !== undefined &&
    value.credentialType !== "password"
  ) {
    return false;
  }
  return true;
}

function is_ice_server_array(value: unknown): value is IceServer[] {
  return Array.isArray(value) && value.length > 0 && value.every(is_ice_server);
}

// `credentials_url` is resolved once at startup in index.mts from the
// required METERED_CREDENTIALS_URL env var (e.g.
// "https://stampatron.metered.live/api/v1/turn/credentials"). Taken as a
// parameter here rather than read from process.env directly, so this
// function stays account-agnostic and unit-testable.
//
// The response is validated against IceServer[] before being returned -
// this is the one point where Metered's raw, untrusted response becomes a
// value the rest of the server can trust structurally. Previously this
// returned Promise<unknown> and the shape only got checked on the client,
// one hop later - a genuine bug (Metered's "create credential" endpoint's
// response briefly got treated as this endpoint's response during setup)
// surfaced there instead of here, which is exactly the failure mode this
// validation is for.
export async function fetch_metered_ice_servers(
  credentials_url: string,
  api_key: string,
): Promise<IceServer[]> {
  const url = `${credentials_url}?apiKey=${encodeURIComponent(api_key)}`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    // Network-level failure. The original error may embed `url` (and
    // therefore the key) — never rethrow or log it here.
    throw new TurnCredentialFetchError("network_error");
  }

  if (!response.ok) {
    throw new TurnCredentialFetchError("bad_status", response.status);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new TurnCredentialFetchError("invalid_json", response.status);
  }

  if (!is_ice_server_array(parsed)) {
    throw new TurnCredentialFetchError("invalid_shape", response.status);
  }

  return parsed;
}
