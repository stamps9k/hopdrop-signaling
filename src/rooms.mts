import { generate_room_code, is_valid_room_code } from "./room_code.mjs";

// How long a room stays alive with no activity before it's swept.
// Rooms exist only long enough for two devices to find each other and
// exchange SDP/ICE — once that's done, connections close and the room's
// job is finished, so this can stay short.
const ROOM_TTL_MS = 5 * 60 * 1000; // 5 minutes

// How often the sweep runs to evict expired rooms.
const CLEANUP_INTERVAL_MS = 30 * 1000; // 30 seconds

interface RoomState {
  device_ids: Set<string>;
  expires_at: number;
}

const rooms = new Map<string, RoomState>();

let cleanup_timer: NodeJS.Timeout | null = null;

/**
 * Creates a new room with a fresh, guaranteed-unique room code and
 * registers the first device in it. Retries generation in the (extremely
 * unlikely) event of a collision with an existing live room.
 */
export function create_room(first_device_id: string, now: number = Date.now()): string {
  let room_code = generate_room_code();
  while (rooms.has(room_code)) {
    room_code = generate_room_code();
  }

  rooms.set(room_code, {
    device_ids: new Set([first_device_id]),
    expires_at: now + ROOM_TTL_MS,
  });

  return room_code;
}

/**
 * Adds a device to an existing, non-expired room and refreshes its TTL.
 * Returns false if the room code is malformed, the room doesn't exist, or
 * it has already expired — callers should treat false as "reject the join".
 */
export function add_device_to_room(
  room_code: string,
  device_id: string,
  now: number = Date.now(),
): boolean {
  if (!is_valid_room_code(room_code)) {
    return false;
  }

  const room = rooms.get(room_code);
  if (!room || room.expires_at <= now) {
    return false;
  }

  room.device_ids.add(device_id);
  room.expires_at = now + ROOM_TTL_MS;
  return true;
}

/**
 * Removes a device from a room. If the room becomes empty as a result, the
 * room itself is deleted immediately rather than waiting for TTL sweep —
 * once the last device leaves, there's no handshake left to relay.
 */
export function remove_device_from_room(room_code: string, device_id: string): void {
  const room = rooms.get(room_code);
  if (!room) {
    return;
  }

  room.device_ids.delete(device_id);
  if (room.device_ids.size === 0) {
    rooms.delete(room_code);
  }
}

/**
 * Returns the device ids currently in a room, or an empty array if the
 * room doesn't exist or has expired. Does not mutate expiry.
 */
export function get_devices_in_room(room_code: string, now: number = Date.now()): string[] {
  const room = rooms.get(room_code);
  if (!room || room.expires_at <= now) {
    return [];
  }
  return Array.from(room.device_ids);
}

/**
 * Returns whether a room exists and has not expired.
 */
export function room_exists(room_code: string, now: number = Date.now()): boolean {
  const room = rooms.get(room_code);
  return room !== undefined && room.expires_at > now;
}

/**
 * Sweeps and deletes all expired rooms. Exported directly (rather than
 * only via the interval) so tests can trigger a deterministic sweep
 * without waiting on real time or timers.
 */
export function cleanup_expired_rooms(now: number = Date.now()): number {
  let removed_count = 0;
  for (const [room_code, room] of rooms) {
    if (room.expires_at <= now) {
      rooms.delete(room_code);
      removed_count++;
    }
  }
  return removed_count;
}

/**
 * Starts the periodic background sweep. Call once at server startup.
 * `unref()` so the timer doesn't keep the Node process alive on its own
 * (e.g. during graceful shutdown or test runs).
 */
export function start_room_cleanup(): void {
  if (cleanup_timer) {
    return;
  }
  cleanup_timer = setInterval(() => cleanup_expired_rooms(), CLEANUP_INTERVAL_MS);
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
