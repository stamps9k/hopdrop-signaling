import { randomUUID } from "node:crypto";
import {
  create_room,
  add_device_to_room,
  remove_device_from_room,
  get_devices_in_room,
  get_device_name,
  get_room_is_turn,
  get_cached_ice_servers,
  cache_ice_servers,
  evict_room,
  type EvictedRoom,
} from "./rooms.mjs";
import type { IceServer } from "./metered_client.mjs";

// --- Protocol types -------------------------------------------------------
//
// SDP offers/answers and ICE candidates are carried as opaque `payload`
// values. The signaling server never needs to understand their contents —
// it only relays them between paired devices — so typing them as `unknown`
// avoids pulling in DOM lib types for a Node service and keeps this layer
// decoupled from whatever shape the browser's WebRTC APIs produce.

export type ClientMessage =
  | { type: "join"; device_name: string; room_code?: string; is_turn?: boolean }
  | { type: "leave" }
  | { type: "offer"; target_device_id: string; payload: unknown }
  | { type: "answer"; target_device_id: string; payload: unknown }
  | { type: "ice-candidate"; target_device_id: string; payload: unknown }
  | { type: "request-turn-credentials" };

export type ServerMessage =
  | {
      type: "room-created";
      room_code: string;
      device_id: string;
      device_name: string;
      is_turn: boolean;
    }
  | {
      type: "room-joined";
      room_code: string;
      device_id: string;
      device_name: string;
      peer_devices: { device_id: string; device_name: string }[];
      is_turn: boolean;
    }
  | { type: "peer-joined"; device_id: string; device_name: string }
  | { type: "peer-left"; device_id: string; device_name: string }
  | { type: "room-expired"; room_code: string }
  | { type: "turn-credentials"; ice_servers: IceServer[] }
  | { type: "offer"; from_device_id: string; payload: unknown }
  | { type: "answer"; from_device_id: string; payload: unknown }
  | { type: "ice-candidate"; from_device_id: string; payload: unknown }
  | { type: "error"; message: string };

/**
 * Minimal shape signaling.mts needs from a connection. Deliberately not
 * `ws`'s `WebSocket` type — keeping this decoupled from the transport
 * library means the relay logic can be unit-tested with a plain fake
 * object instead of a real socket.
 */
export interface DeviceConnection {
  send(data: string): void;
}

// --- Module state ----------------------------------------------------------

const device_connections = new Map<string, DeviceConnection>();
const device_room_codes = new Map<string, string>();

// --- TURN credential minting -----------------------------------------------

/**
 * Vendor-agnostic hook for minting TURN credentials - returns the
 * already-validated ice_servers value to forward to the client (see
 * metered_client.mts's fetch_metered_ice_servers). signaling.mts
 * deliberately has no knowledge of which provider is behind this (Metered
 * today, self-hosted coturn potentially later) - index.mts supplies the
 * actual implementation via configure_turn_credentials, the same shape as
 * how on_rooms_expired gets wired into rooms.mts's cleanup timer.
 *
 * Implementations should ensure any error they throw has a message safe
 * to log server-side (no secrets, no request URLs) - handle_request_turn_
 * credentials logs it on failure for diagnostic visibility.
 */
export type FetchIceServers = () => Promise<IceServer[]>;

let fetch_ice_servers: FetchIceServers | undefined;

/**
 * Configures the function used to mint TURN credentials when a room's
 * cache is empty. Call once at server startup. Not calling this at all is
 * safe as long as no room has is_turn: true - a request-turn-credentials
 * message against a TURN-enabled room without a configured fetcher is
 * treated as a failure (closes the room), same as the fetcher throwing.
 */
export function configure_turn_credentials(fetcher: FetchIceServers): void {
  fetch_ice_servers = fetcher;
}

// --- Connection lifecycle ---------------------------------------------------

/**
 * Registers a newly-connected device and assigns it a server-generated id.
 * Call once per new WebSocket connection, before any messages are handled.
 */
export function handle_connection(connection: DeviceConnection): string {
  const device_id = randomUUID();
  device_connections.set(device_id, connection);
  return device_id;
}

/**
 * Cleans up all state for a device that has disconnected: removes it from
 * its room (if any), notifies remaining peers in that room, and forgets
 * its connection. Safe to call even if the device was never in a room.
 */
export function handle_disconnect(device_id: string): void {
  leave_current_room(device_id);
  device_connections.delete(device_id);
}

// --- Message parsing ---------------------------------------------------

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function is_relay_message_shape<T extends Record<string, unknown>>(
  value: T,
): value is T & { target_device_id: string; payload: unknown } {
  return typeof value.target_device_id === "string" && "payload" in value;
}

/**
 * Safely parses and validates a raw incoming string into a well-formed
 * ClientMessage. Returns null for anything malformed — invalid JSON,
 * unknown type, or missing required fields — so the caller can reject it
 * without ever trusting unvalidated client input downstream.
 */
export function parse_client_message(
  raw_message: string,
): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw_message);
  } catch {
    return null;
  }

  if (!is_record(parsed) || typeof parsed.type !== "string") {
    return null;
  }

  switch (parsed.type) {
    case "join":
      if (typeof parsed.device_name !== "string") {
        return null;
      }
      if (
        parsed.room_code !== undefined &&
        typeof parsed.room_code !== "string"
      ) {
        return null;
      }
      if (parsed.is_turn !== undefined && typeof parsed.is_turn !== "boolean") {
        return null;
      }
      return {
        type: "join",
        device_name: parsed.device_name,
        room_code: parsed.room_code as string | undefined,
        is_turn: parsed.is_turn as boolean | undefined,
      };

    case "leave":
      return { type: "leave" };

    case "offer":
    case "answer":
    case "ice-candidate":
      if (!is_relay_message_shape(parsed)) {
        return null;
      }
      return {
        type: parsed.type,
        target_device_id: parsed.target_device_id,
        payload: parsed.payload,
      };

    case "request-turn-credentials":
      return { type: "request-turn-credentials" };

    default:
      return null;
  }
}

// --- Sending -------------------------------------------------------------

function send_to_device(device_id: string, message: ServerMessage): void {
  const connection = device_connections.get(device_id);
  if (!connection) {
    return;
  }
  connection.send(JSON.stringify(message));
}

// --- Room join / leave -------------------------------------------------

// Keeps a device name to a sane, displayable length. Mirrored on the
// client side (e.g. an input maxlength) for UX feedback before hitting
// this server-side check, but this is the actual enforcement point.
const MAX_DEVICE_NAME_LENGTH = 40;

/**
 * Trims a raw device name and validates it's non-empty and within the
 * length limit. Returns null for anything that fails - callers should
 * treat null as "reject with a specific error", distinct from
 * parse_client_message's null (which means "malformed shape entirely").
 */
function normalize_device_name(raw_device_name: string): string | null {
  const trimmed = raw_device_name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DEVICE_NAME_LENGTH) {
    return null;
  }
  return trimmed;
}

function handle_join(
  device_id: string,
  raw_device_name: string,
  room_code?: string,
  is_turn?: boolean,
): void {
  // Single `now` for this whole join, so every rooms.mts call below is
  // consistent - avoids a (very unlikely, but real) TTL-boundary race from
  // calling Date.now() separately at each step.
  const now = Date.now();

  // Absent on the wire means "no TURN enforcement requested" - resolved
  // to a concrete boolean here so every call below deals with a real
  // value, not undefined.
  const resolved_is_turn = is_turn ?? false;

  const device_name = normalize_device_name(raw_device_name);
  if (device_name === null) {
    send_to_device(device_id, {
      type: "error",
      message: `device name must be between 1 and ${MAX_DEVICE_NAME_LENGTH} characters`,
    });
    return;
  }

  if (room_code === undefined) {
    const new_room_code = create_room(
      device_id,
      device_name,
      resolved_is_turn,
      now,
    );
    device_room_codes.set(device_id, new_room_code);
    send_to_device(device_id, {
      type: "room-created",
      room_code: new_room_code,
      device_id,
      device_name,
      is_turn: resolved_is_turn,
    });
    return;
  }

  const result = add_device_to_room(
    room_code,
    device_id,
    device_name,
    resolved_is_turn,
    now,
  );
  if (!result.ok) {
    const message =
      result.reason === "name_taken"
        ? `the name "${device_name}" is already taken in this room — choose a different name`
        : result.reason === "is_turn_mismatch"
          ? "is_turn does not match room configuration"
          : `room ${room_code} does not exist or has expired`;
    send_to_device(device_id, { type: "error", message });
    return;
  }

  device_room_codes.set(device_id, room_code);

  const peer_device_ids = get_devices_in_room(room_code, now).filter(
    (id) => id !== device_id,
  );
  const peer_devices = peer_device_ids.map((peer_device_id) => ({
    device_id: peer_device_id,
    // Defensive fallback only - every id here came from this same room's
    // live device list moments ago, so a lookup miss shouldn't happen in
    // practice.
    device_name: get_device_name(room_code, peer_device_id, now) ?? "",
  }));

  send_to_device(device_id, {
    type: "room-joined",
    room_code,
    device_id,
    device_name,
    peer_devices,
    // Guaranteed to equal resolved_is_turn - a mismatch would already
    // have returned above via the is_turn_mismatch branch.
    is_turn: resolved_is_turn,
  });

  for (const peer_device_id of peer_device_ids) {
    send_to_device(peer_device_id, {
      type: "peer-joined",
      device_id,
      device_name,
    });
  }
}

function leave_current_room(device_id: string): void {
  const room_code = device_room_codes.get(device_id);
  if (!room_code) {
    return;
  }

  // Captured before removal - once remove_device_from_room runs, this
  // device's name is gone from room state and peer-left couldn't include it.
  const device_name = get_device_name(room_code, device_id) ?? "";

  const remaining_peers_before = get_devices_in_room(room_code).filter(
    (id) => id !== device_id,
  );

  remove_device_from_room(room_code, device_id);
  device_room_codes.delete(device_id);

  for (const peer_device_id of remaining_peers_before) {
    send_to_device(peer_device_id, {
      type: "peer-left",
      device_id,
      device_name,
    });
  }
}

// --- Room expiry notification -------------------------------------------

/**
 * Notifies every device that was in an expired room, and forgets those
 * devices' room mapping so a stray leave/relay afterward doesn't
 * reference a room that no longer exists. Deliberately does not close the
 * device's connection — the socket stays open so the device can create or
 * join a new room immediately without reconnecting. Intended to be passed
 * as the `on_rooms_expired` callback to rooms.mts's start_room_cleanup;
 * this is the seam where room-expiry state becomes an actual message on a
 * socket, since rooms.mts has no notion of connections. Also reused
 * directly (via close_room_due_to_turn_failure below, wrapping a single
 * evict_room result) when a room's upfront TURN credential fetch fails -
 * same notification shape, different trigger. A future improvement is a
 * distinct room-closed message with a reason field, so the client can
 * tell these two cases apart instead of both surfacing as room-expired.
 */
export function notify_rooms_expired(evicted_rooms: EvictedRoom[]): void {
  for (const { room_code, device_ids } of evicted_rooms) {
    for (const device_id of device_ids) {
      send_to_device(device_id, { type: "room-expired", room_code });
      device_room_codes.delete(device_id);
    }
  }
}

// --- TURN credential requests -------------------------------------------

/**
 * Closes a room whose TURN credential fetch failed, reusing the same
 * eviction + notification path as TTL expiry - room-expired to every
 * device that was in the room, including whichever device's request
 * triggered the failure. No role distinction, same as TTL expiry.
 */
function close_room_due_to_turn_failure(room_code: string): void {
  const evicted_room = evict_room(room_code);
  if (evicted_room) {
    notify_rooms_expired([evicted_room]);
  }
}

/**
 * Handles a request-turn-credentials message: looks up the requesting
 * device's room, confirms it's configured for TURN, and serves cached
 * credentials if present or mints fresh ones otherwise - at most one
 * mint per room, reused by every device that asks. A failed mint
 * (fetch_ice_servers rejects, or was never configured) is treated as
 * fatal to the room, per the "is_turn enforces TURN" design: the room is
 * evicted and every device in it is notified via room-expired.
 *
 * Async because minting involves a network call. handle_client_message
 * itself stays synchronous - this is fired without awaiting there and
 * catches its own failures internally, so nothing here becomes an
 * unhandled rejection.
 */
async function handle_request_turn_credentials(
  device_id: string,
  now: number = Date.now(),
): Promise<void> {
  const room_code = device_room_codes.get(device_id);
  if (!room_code) {
    send_to_device(device_id, {
      type: "error",
      message: "you are not currently in a room",
    });
    return;
  }

  const room_is_turn = get_room_is_turn(room_code, now);
  if (room_is_turn === undefined) {
    send_to_device(device_id, {
      type: "error",
      message: `room ${room_code} does not exist or has expired`,
    });
    return;
  }
  if (!room_is_turn) {
    send_to_device(device_id, {
      type: "error",
      message: `room ${room_code} is not configured to use TURN`,
    });
    return;
  }

  const cached = get_cached_ice_servers(room_code, now);
  if (cached.ok) {
    send_to_device(device_id, {
      type: "turn-credentials",
      ice_servers: cached.ice_servers,
    });
    return;
  }
  if (cached.reason === "room_not_found") {
    // Extremely unlikely given get_room_is_turn just confirmed the room
    // exists, moments ago and synchronously - handled defensively rather
    // than assumed impossible.
    send_to_device(device_id, {
      type: "error",
      message: `room ${room_code} does not exist or has expired`,
    });
    return;
  }

  if (!fetch_ice_servers) {
    // Misconfiguration: an is_turn room exists but index.mts never called
    // configure_turn_credentials. Enforcing TURN without any way to mint
    // credentials can't be honored, so the room can't safely continue.
    console.error(
      "request-turn-credentials: no fetcher configured, closing room",
      room_code,
    );
    close_room_due_to_turn_failure(room_code);
    return;
  }

  let ice_servers: IceServer[];
  try {
    ice_servers = await fetch_ice_servers();
  } catch (error) {
    // Whatever fetch_ice_servers throws is expected to have a message
    // safe to log (see FetchIceServers' docs above) - metered_client.mts's
    // TurnCredentialFetchError always does, since its message is a fixed
    // string with no interpolation of the URL or API key. Logging this is
    // what would have caught, at the source, the create-vs-get Metered
    // endpoint mix-up that previously only surfaced client-side as an
    // opaque parse error, several hops away from the actual cause.
    console.error(
      "TURN credential fetch failed, closing room:",
      room_code,
      error instanceof Error ? error.message : error,
    );
    close_room_due_to_turn_failure(room_code);
    return;
  }

  cache_ice_servers(room_code, ice_servers);
  send_to_device(device_id, { type: "turn-credentials", ice_servers });
}

// --- SDP / ICE relay ---------------------------------------------------

function handle_relay(
  device_id: string,
  message: {
    type: "offer" | "answer" | "ice-candidate";
    target_device_id: string;
    payload: unknown;
  },
): void {
  const sender_room_code = device_room_codes.get(device_id);
  const target_room_code = device_room_codes.get(message.target_device_id);

  // Devices may only relay to a peer in the same room — prevents a device
  // from using its connection to message an arbitrary device id it
  // guessed or learned elsewhere.
  if (!sender_room_code || sender_room_code !== target_room_code) {
    send_to_device(device_id, {
      type: "error",
      message: `${message.target_device_id} is not in your room`,
    });
    return;
  }

  send_to_device(message.target_device_id, {
    type: message.type,
    from_device_id: device_id,
    payload: message.payload,
  });
}

// --- Top-level dispatch ---------------------------------------------------

/**
 * Parses and routes a single raw message from a connected device. This is
 * the main entry point index.mts should call from its WebSocket 'message'
 * handler.
 */
// Rejects a raw message before any parsing is attempted if it's larger
// than any legitimate message should be. SDP offers/answers and ICE
// candidates are typically a few KB at most; this leaves generous
// headroom while bounding the worst case. This is app-level
// defense-in-depth, not a replacement for a `maxPayload` limit at the
// WebSocket server/library level - that's the primary defense, since it
// can reject an oversized frame before it's ever fully buffered into a
// JS string in the first place. Measured in UTF-16 code units (raw
// string .length), not exact UTF-8 byte count - close enough for a
// safety margin, not meant to be byte-precise.
export const MAX_RAW_MESSAGE_LENGTH = 64 * 1024;

export function handle_client_message(
  device_id: string,
  raw_message: string,
): void {
  if (raw_message.length > MAX_RAW_MESSAGE_LENGTH) {
    send_to_device(device_id, {
      type: "error",
      message: `message too large (max ${MAX_RAW_MESSAGE_LENGTH} characters)`,
    });
    return;
  }

  const message = parse_client_message(raw_message);
  if (!message) {
    send_to_device(device_id, { type: "error", message: "malformed message" });
    return;
  }

  switch (message.type) {
    case "join":
      handle_join(
        device_id,
        message.device_name,
        message.room_code,
        message.is_turn,
      );
      return;
    case "leave":
      leave_current_room(device_id);
      return;
    case "offer":
    case "answer":
    case "ice-candidate":
      handle_relay(device_id, message);
      return;
    case "request-turn-credentials":
      void handle_request_turn_credentials(device_id).catch(() => {
        // handle_request_turn_credentials handles its own failures
        // internally (sending an error, or evicting the room via
        // close_room_due_to_turn_failure) - this catch exists only to
        // prevent an unhandled promise rejection, since
        // handle_client_message itself is synchronous.
      });
      return;
  }
}

// --- Test helpers -----------------------------------------------------

/**
 * Returns the room code a device currently believes it's in, or undefined.
 * Test-only introspection helper.
 */
export function get_room_code_for_device(
  device_id: string,
): string | undefined {
  return device_room_codes.get(device_id);
}

/**
 * Clears all module-level signaling state (connections, room mappings,
 * and the configured TURN credential fetcher). Test-only helper for
 * resetting state between test files.
 */
export function clear_all_signaling_state(): void {
  device_connections.clear();
  device_room_codes.clear();
  fetch_ice_servers = undefined;
}
