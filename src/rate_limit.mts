// Sliding-window limit on how many new connection attempts a single IP
// may make. Protects against connection-flood abuse independently of how
// many of those connections are still open.
const CONNECTION_RATE_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_CONNECTION_ATTEMPTS_PER_WINDOW = 20;

// Hard cap on how many WebSocket connections a single IP may hold open at
// once. Protects the low-power server from one client (malicious or
// buggy) exhausting connection/memory resources.
const MAX_CONCURRENT_CONNECTIONS_PER_IP = 5;

// How often stale per-IP tracking entries (no recent attempts, no active
// connections) are swept from memory.
const STALE_STATE_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

interface IpState {
  attempt_timestamps: number[];
  active_connection_count: number;
}

const ip_states = new Map<string, IpState>();

let cleanup_timer: NodeJS.Timeout | null = null;

function get_or_create_ip_state(ip: string): IpState {
  let state = ip_states.get(ip);
  if (!state) {
    state = { attempt_timestamps: [], active_connection_count: 0 };
    ip_states.set(ip, state);
  }
  return state;
}

function prune_old_attempts(state: IpState, now: number): void {
  state.attempt_timestamps = state.attempt_timestamps.filter(
    (timestamp) => now - timestamp < CONNECTION_RATE_WINDOW_MS,
  );
}

/**
 * Attempts to accept a new connection from the given IP, checking both the
 * sliding-window attempt rate and the concurrent connection cap. If
 * allowed, records the attempt and increments the active connection count
 * atomically with the check — callers should treat a `true` result as
 * "connection accepted" and must pair it with a later `release_connection`
 * call when that connection closes.
 *
 * The attempt is recorded even when the *concurrent* cap (not the rate
 * cap) is the reason for rejection, and rejected rate-limited attempts are
 * still counted — otherwise an attacker could probe indefinitely at zero
 * cost by triggering only the concurrent-cap rejection path.
 */
export function try_accept_connection(
  ip: string,
  now: number = Date.now(),
): boolean {
  const state = get_or_create_ip_state(ip);
  prune_old_attempts(state, now);

  if (state.attempt_timestamps.length >= MAX_CONNECTION_ATTEMPTS_PER_WINDOW) {
    state.attempt_timestamps.push(now);
    return false;
  }

  state.attempt_timestamps.push(now);

  if (state.active_connection_count >= MAX_CONCURRENT_CONNECTIONS_PER_IP) {
    return false;
  }

  state.active_connection_count += 1;
  return true;
}

/**
 * Releases a previously-accepted connection slot for an IP. Must be called
 * exactly once for every `try_accept_connection` call that returned true,
 * typically from the WebSocket 'close' handler.
 */
export function release_connection(ip: string): void {
  const state = ip_states.get(ip);
  if (!state) {
    return;
  }
  state.active_connection_count = Math.max(
    0,
    state.active_connection_count - 1,
  );
}

/**
 * Returns the number of currently active (accepted, not yet released)
 * connections tracked for an IP. Useful for logging/introspection.
 */
export function get_active_connection_count(ip: string): number {
  return ip_states.get(ip)?.active_connection_count ?? 0;
}

/**
 * Extracts the real client IP for rate-limiting purposes. Prefers the
 * first address in X-Forwarded-For, since connections arrive via the
 * self-hosted nginx reverse proxy and socket.remoteAddress would
 * otherwise always resolve to nginx's own address. Falls back to the raw
 * socket address when no proxy header is present (e.g. local dev without
 * nginx in front).
 *
 * Takes plain header/address values rather than a full IncomingMessage so
 * this stays testable without constructing a real HTTP request object.
 */
export function extract_client_ip(
  forwarded_for_header: string | string[] | undefined,
  socket_remote_address: string | undefined,
): string {
  const header_value = Array.isArray(forwarded_for_header)
    ? forwarded_for_header[0]
    : forwarded_for_header;

  if (header_value) {
    // X-Forwarded-For may be a comma-separated chain; the first entry is
    // the original client.
    const first_ip = header_value.split(",")[0]?.trim();
    if (first_ip) {
      return first_ip;
    }
  }

  return socket_remote_address ?? "unknown";
}

/**
 * Sweeps and deletes tracking state for IPs with no recent attempts and no
 * active connections. Exported directly (not just via the interval) so
 * tests can trigger a deterministic sweep without waiting on real timers.
 */
export function cleanup_stale_ip_state(now: number = Date.now()): number {
  let removed_count = 0;
  for (const [ip, state] of ip_states) {
    prune_old_attempts(state, now);
    if (
      state.attempt_timestamps.length === 0 &&
      state.active_connection_count === 0
    ) {
      ip_states.delete(ip);
      removed_count++;
    }
  }
  return removed_count;
}

/**
 * Starts the periodic background sweep of stale IP tracking state. Call
 * once at server startup, alongside rooms.mts's start_room_cleanup.
 */
export function start_rate_limit_cleanup(): void {
  if (cleanup_timer) {
    return;
  }
  cleanup_timer = setInterval(
    () => cleanup_stale_ip_state(),
    STALE_STATE_CLEANUP_INTERVAL_MS,
  );
  cleanup_timer.unref();
}

/**
 * Stops the periodic background sweep. Mainly useful for tests and clean
 * shutdown.
 */
export function stop_rate_limit_cleanup(): void {
  if (cleanup_timer) {
    clearInterval(cleanup_timer);
    cleanup_timer = null;
  }
}

/**
 * Clears all module-level IP tracking state. Test-only helper for
 * resetting state between test files.
 */
export function clear_all_rate_limit_state(): void {
  ip_states.clear();
}
