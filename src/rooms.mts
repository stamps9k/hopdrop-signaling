import { generate_room_code, is_valid_room_code } from "./room_code.mjs";

// How long a room stays alive with no activity before it's swept.
// Rooms exist only long enough for two devices to find each other and
// exchange SDP/ICE — once that's done, connections close and the room's
// job is finished, so this can stay short.
const ROOM_TTL_MS = 5 * 60 * 1000; // 5 minutes

// How often the sweep runs to evict expired rooms.
const CLEANUP_INTERVAL_MS = 30 * 1000; // 30 seconds

interface RoomState {
  // device_id -> device_name. A Map (not a Set) since names now need to be
  // tracked alongside ids for uniqueness enforcement and for telling peers
  // apart in the UI.
  device_names: Map<string, string>;
  // Set once at room creation, immutable for the room's lifetime. Devices
  // joining later must match this value or are rejected - see
  // add_device_to_room's "is_turn_mismatch" result.
  is_turn: boolean;
  // Populated on first successful Metered fetch for this room; reused by
  // every later request-turn-credentials call (from any device in the
  // room) instead of minting fresh credentials per device. Only ever set
  // on success - a failed fetch is never cached, so the next attempt (by
  // any device) gets a clean retry rather than inheriting a prior
  // failure.
  cached_ice_servers?: unknown;
  expires_at: number;
}

const rooms = new Map<string, RoomState>();

let cleanup_timer: NodeJS.Timeout | null = null;

// Case-insensitive, trimmed comparison so "Sam's Laptop" and "sam's laptop"
// can't coexist in the same room - the point of enforcing uniqueness here
// is to prevent one device from being confused for another, and a
// same-except-case name is exactly that kind of confusable pair.
function normalize_device_name_for_comparison(device_name: string): string {
  return device_name.trim().toLowerCase();
}

/**
 * Creates a new room with a fresh, guaranteed-unique room code and
 * registers the first device in it under the given name. Retries
 * generation in the (extremely unlikely) event of a collision with an
 * existing live room. No uniqueness check is needed here - the creator is
 * always the room's only device at this point.
 */
export function create_room(
  first_device_id: string,
  first_device_name: string,
  is_turn: boolean,
  now: number = Date.now(),
): string {
  let room_code = generate_room_code();
  while (rooms.has(room_code)) {
    room_code = generate_room_code();
  }

  rooms.set(room_code, {
    device_names: new Map([[first_device_id, first_device_name]]),
    is_turn,
    expires_at: now + ROOM_TTL_MS,
  });

  return room_code;
}

export type AddDeviceToRoomResult =
  | { ok: true }
  | {
      ok: false;
      reason: "room_not_found" | "name_taken" | "is_turn_mismatch";
    };

/**
 * Adds a device to an existing, non-expired room under the given name and
 * refreshes the room's TTL. Rejects if the room code is malformed or the
 * room doesn't exist/has expired ("room_not_found"), if the joining
 * device's is_turn doesn't match the room's stored value
 * ("is_turn_mismatch" - is_turn is set once at creation and can't be
 * renegotiated), or if another device already in the room has the same
 * name, case-insensitively ("name_taken") - this is the enforcement point
 * that makes device names actually trustworthy rather than just a UI
 * label: a device cannot join under a name already claimed by someone
 * else in that room. is_turn is checked before name uniqueness, so a
 * device mismatched on both gets "is_turn_mismatch".
 */
export function add_device_to_room(
  room_code: string,
  device_id: string,
  device_name: string,
  is_turn: boolean,
  now: number = Date.now(),
): AddDeviceToRoomResult {
  if (!is_valid_room_code(room_code)) {
    return { ok: false, reason: "room_not_found" };
  }

  const room = rooms.get(room_code);
  if (!room || room.expires_at <= now) {
    return { ok: false, reason: "room_not_found" };
  }

  if (room.is_turn !== is_turn) {
    return { ok: false, reason: "is_turn_mismatch" };
  }

  const normalized_new_name = normalize_device_name_for_comparison(device_name);
  for (const existing_name of room.device_names.values()) {
    if (
      normalize_device_name_for_comparison(existing_name) ===
      normalized_new_name
    ) {
      return { ok: false, reason: "name_taken" };
    }
  }

  room.device_names.set(device_id, device_name);
  room.expires_at = now + ROOM_TTL_MS;
  return { ok: true };
}

/**
 * Removes a device from a room. If the room becomes empty as a result, the
 * room itself is deleted immediately rather than waiting for TTL sweep —
 * once the last device leaves, there's no handshake left to relay.
 */
export function remove_device_from_room(
  room_code: string,
  device_id: string,
): void {
  const room = rooms.get(room_code);
  if (!room) {
    return;
  }

  room.device_names.delete(device_id);
  if (room.device_names.size === 0) {
    rooms.delete(room_code);
  }
}

/**
 * Returns the device ids currently in a room, or an empty array if the
 * room doesn't exist or has expired. Does not mutate expiry. Unchanged in
 * shape by the device-naming feature - still ids only. Use
 * get_device_name for a specific device's name.
 */
export function get_devices_in_room(
  room_code: string,
  now: number = Date.now(),
): string[] {
  const room = rooms.get(room_code);
  if (!room || room.expires_at <= now) {
    return [];
  }
  return Array.from(room.device_names.keys());
}

/**
 * Returns a device's name within a room, or undefined if the room doesn't
 * exist/has expired, or the device isn't in it. Does not mutate expiry.
 */
export function get_device_name(
  room_code: string,
  device_id: string,
  now: number = Date.now(),
): string | undefined {
  const room = rooms.get(room_code);
  if (!room || room.expires_at <= now) {
    return undefined;
  }
  return room.device_names.get(device_id);
}

/**
 * Returns whether a room exists and has not expired.
 */
export function room_exists(
  room_code: string,
  now: number = Date.now(),
): boolean {
  const room = rooms.get(room_code);
  return room !== undefined && room.expires_at > now;
}

/**
 * Returns whether a room enforces TURN, or undefined if the room doesn't
 * exist or has expired. Does not mutate expiry. Set once at creation -
 * see create_room and add_device_to_room's mismatch check.
 */
export function get_room_is_turn(
  room_code: string,
  now: number = Date.now(),
): boolean | undefined {
  const room = rooms.get(room_code);
  if (!room || room.expires_at <= now) {
    return undefined;
  }
  return room.is_turn;
}

export type CachedIceServersLookup =
  | { ok: true; ice_servers: unknown }
  | { ok: false; reason: "room_not_found" | "not_cached" };

/**
 * Looks up TURN credentials already cached for a room, distinguishing
 * "room doesn't exist/has expired" from "room exists but nothing cached
 * yet" - the caller (signaling.mts) needs to tell these apart to know
 * whether to serve the cached value or go mint fresh credentials via
 * cache_ice_servers.
 */
export function get_cached_ice_servers(
  room_code: string,
  now: number = Date.now(),
): CachedIceServersLookup {
  const room = rooms.get(room_code);
  if (!room || room.expires_at <= now) {
    return { ok: false, reason: "room_not_found" };
  }
  if (room.cached_ice_servers === undefined) {
    return { ok: false, reason: "not_cached" };
  }
  return { ok: true, ice_servers: room.cached_ice_servers };
}

/**
 * Caches TURN credentials on a room so later request-turn-credentials
 * calls (from any device in the room) reuse them instead of triggering
 * another Metered fetch. Silently a no-op if the room no longer exists -
 * e.g. it expired between the fetch starting and this call completing, in
 * which case there's nothing left to cache against.
 */
export function cache_ice_servers(
  room_code: string,
  ice_servers: unknown,
): void {
  const room = rooms.get(room_code);
  if (!room) {
    return;
  }
  room.cached_ice_servers = ice_servers;
}

/**
 * A room that was evicted (either by cleanup_expired_rooms or evict_room),
 * along with the device ids that were in it at the moment of eviction.
 * Captured before deletion since the room's device list is gone once
 * eviction removes it - this is the only way a caller can know who to
 * notify.
 */
export interface EvictedRoom {
  room_code: string;
  device_ids: string[];
}

/**
 * Immediately evicts one specific room, regardless of its expiry time,
 * returning what was evicted (same shape as cleanup_expired_rooms) so the
 * caller can notify affected devices - or null if the room didn't exist.
 * Distinct from the TTL sweep: this is for closing a room in response to
 * something other than a timeout - e.g. a failed upfront TURN credential
 * fetch, which per the design closes the room the same way a timeout
 * does. Callers pass the result to signaling.mts's notify_rooms_expired
 * (wrapped in a one-element array) to reuse the same room-expired
 * notification path.
 */
export function evict_room(room_code: string): EvictedRoom | null {
  const room = rooms.get(room_code);
  if (!room) {
    return null;
  }
  const evicted_room: EvictedRoom = {
    room_code,
    device_ids: Array.from(room.device_names.keys()),
  };
  rooms.delete(room_code);
  return evicted_room;
}

/**
 * Sweeps and deletes all expired rooms, returning what was evicted so the
 * caller can notify affected devices. Exported directly (rather than only
 * via the interval) so tests can trigger a deterministic sweep without
 * waiting on real time or timers.
 */
export function cleanup_expired_rooms(now: number = Date.now()): EvictedRoom[] {
  const evicted_rooms: EvictedRoom[] = [];
  for (const [room_code, room] of rooms) {
    if (room.expires_at <= now) {
      evicted_rooms.push({
        room_code,
        device_ids: Array.from(room.device_names.keys()),
      });
      rooms.delete(room_code);
    }
  }
  return evicted_rooms;
}

/**
 * Starts the periodic background sweep. Call once at server startup.
 * `on_rooms_expired`, if provided, is invoked with whatever the sweep
 * evicted on each run (only when at least one room was evicted) - this
 * module has no notion of connections, so notifying affected devices is
 * entirely the caller's responsibility. `unref()` so the timer doesn't
 * keep the Node process alive on its own (e.g. during graceful shutdown
 * or test runs).
 */
export function start_room_cleanup(
  on_rooms_expired?: (evicted_rooms: EvictedRoom[]) => void,
): void {
  if (cleanup_timer) {
    return;
  }
  cleanup_timer = setInterval(() => {
    const evicted_rooms = cleanup_expired_rooms();
    if (evicted_rooms.length > 0) {
      on_rooms_expired?.(evicted_rooms);
    }
  }, CLEANUP_INTERVAL_MS);
  cleanup_timer.unref();
}

/**
 * Stops the periodic background sweep. Mainly useful for tests and clean
 * shutdown, since a leaked interval will keep re-scheduling itself.
 */
export function stop_room_cleanup(): void {
  if (cleanup_timer) {
    clearInterval(cleanup_timer);
    cleanup_timer = null;
  }
}

/**
 * Removes all rooms unconditionally. Test-only helper to reset module
 * state between test files, since `rooms` is module-level shared state.
 */
export function clear_all_rooms(): void {
  rooms.clear();
}
