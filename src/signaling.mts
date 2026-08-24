import { randomUUID } from "node:crypto";
import {
  create_room,
  add_device_to_room,
  remove_device_from_room,
  get_devices_in_room,
  get_device_name,
} from "./rooms.mjs";

// --- Protocol types -------------------------------------------------------
//
// SDP offers/answers and ICE candidates are carried as opaque `payload`
// values. The signaling server never needs to understand their contents —
// it only relays them between paired devices — so typing them as `unknown`
// avoids pulling in DOM lib types for a Node service and keeps this layer
// decoupled from whatever shape the browser's WebRTC APIs produce.

export type ClientMessage =
  | { type: "join"; device_name: string; room_code?: string }
  | { type: "leave" }
  | { type: "offer"; target_device_id: string; payload: unknown }
  | { type: "answer"; target_device_id: string; payload: unknown }
  | { type: "ice-candidate"; target_device_id: string; payload: unknown };

export type ServerMessage =
  | {
      type: "room-created";
      room_code: string;
      device_id: string;
      device_name: string;
    }
  | {
      type: "room-joined";
      room_code: string;
      device_id: string;
      device_name: string;
      peer_devices: { device_id: string; device_name: string }[];
    }
  | { type: "peer-joined"; device_id: string; device_name: string }
  | { type: "peer-left"; device_id: string; device_name: string }
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
      return {
        type: "join",
        device_name: parsed.device_name,
        room_code: parsed.room_code as string | undefined,
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
): void {
  // Single `now` for this whole join, so every rooms.mts call below is
  // consistent - avoids a (very unlikely, but real) TTL-boundary race from
  // calling Date.now() separately at each step.
  const now = Date.now();

  const device_name = normalize_device_name(raw_device_name);
  if (device_name === null) {
    send_to_device(device_id, {
      type: "error",
      message: `device name must be between 1 and ${MAX_DEVICE_NAME_LENGTH} characters`,
    });
    return;
  }

  if (room_code === undefined) {
    const new_room_code = create_room(device_id, device_name, now);
    device_room_codes.set(device_id, new_room_code);
    send_to_device(device_id, {
      type: "room-created",
      room_code: new_room_code,
      device_id,
      device_name,
    });
    return;
  }

  const result = add_device_to_room(room_code, device_id, device_name, now);
  if (!result.ok) {
    const message =
      result.reason === "name_taken"
        ? `the name "${device_name}" is already taken in this room — choose a different name`
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
export function handle_client_message(
  device_id: string,
  raw_message: string,
): void {
  const message = parse_client_message(raw_message);
  if (!message) {
    send_to_device(device_id, { type: "error", message: "malformed message" });
    return;
  }

  switch (message.type) {
    case "join":
      handle_join(device_id, message.device_name, message.room_code);
      return;
    case "leave":
      leave_current_room(device_id);
      return;
    case "offer":
    case "answer":
    case "ice-candidate":
      handle_relay(device_id, message);
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
 * Clears all module-level signaling state (connections + room mappings).
 * Test-only helper for resetting state between test files.
 */
export function clear_all_signaling_state(): void {
  device_connections.clear();
  device_room_codes.clear();
}
