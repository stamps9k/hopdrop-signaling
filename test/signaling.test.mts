import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  handle_connection,
  handle_client_message,
  handle_disconnect,
  parse_client_message,
  get_room_code_for_device,
  notify_rooms_expired,
  clear_all_signaling_state,
} from "../src/signaling.mjs";
import type { ServerMessage } from "../src/signaling.mjs";
import { clear_all_rooms } from "../src/rooms.mjs";

/**
 * A minimal fake satisfying the DeviceConnection interface. Captures every
 * message sent to it (as parsed JSON) so tests can assert on what a
 * device actually received, without needing a real WebSocket.
 */
function make_fake_connection() {
  const messages: ServerMessage[] = [];
  return {
    send(data: string) {
      messages.push(JSON.parse(data) as ServerMessage);
    },
    messages,
  };
}

/**
 * Asserts a captured message is the expected variant of the ServerMessage
 * union and narrows its type accordingly, so callers can read
 * variant-specific fields without an `any` cast.
 */
function expect_message_type<T extends ServerMessage["type"]>(
  message: ServerMessage,
  type: T,
): Extract<ServerMessage, { type: T }> {
  assert.equal(message.type, type);
  return message as Extract<ServerMessage, { type: T }>;
}

// Both rooms.mts and signaling.mts hold module-level state shared across
// every test in this file, so each test needs a clean slate.
beforeEach(() => {
  clear_all_rooms();
  clear_all_signaling_state();
});

describe("parse_client_message", () => {
  test("returns null for invalid JSON", () => {
    assert.equal(parse_client_message("not json"), null);
  });

  test("returns null for a JSON value that isn't an object", () => {
    assert.equal(parse_client_message("42"), null);
    assert.equal(parse_client_message('"a string"'), null);
    assert.equal(parse_client_message("null"), null);
  });

  test("returns null for an object with no type field", () => {
    assert.equal(
      parse_client_message(JSON.stringify({ room_code: "ABC123" })),
      null,
    );
  });

  test("returns null for an unknown type", () => {
    assert.equal(
      parse_client_message(JSON.stringify({ type: "not-a-real-type" })),
      null,
    );
  });

  test("parses a join message with a device_name and no room_code", () => {
    const result = parse_client_message(
      JSON.stringify({ type: "join", device_name: "Device A" }),
    );
    assert.deepEqual(result, {
      type: "join",
      device_name: "Device A",
      room_code: undefined,
    });
  });

  test("parses a join message with a device_name and room_code", () => {
    const result = parse_client_message(
      JSON.stringify({
        type: "join",
        device_name: "Device A",
        room_code: "ABC123",
      }),
    );
    assert.deepEqual(result, {
      type: "join",
      device_name: "Device A",
      room_code: "ABC123",
    });
  });

  test("returns null when join has no device_name at all", () => {
    const result = parse_client_message(JSON.stringify({ type: "join" }));
    assert.equal(result, null);
  });

  test("returns null when join's device_name is not a string", () => {
    const result = parse_client_message(
      JSON.stringify({ type: "join", device_name: 123 }),
    );
    assert.equal(result, null);
  });

  test("returns null when join's room_code is not a string", () => {
    const result = parse_client_message(
      JSON.stringify({ type: "join", device_name: "Device A", room_code: 123 }),
    );
    assert.equal(result, null);
  });

  test("parses a leave message", () => {
    const result = parse_client_message(JSON.stringify({ type: "leave" }));
    assert.deepEqual(result, { type: "leave" });
  });

  test("parses a well-formed offer message", () => {
    const result = parse_client_message(
      JSON.stringify({
        type: "offer",
        target_device_id: "device-B",
        payload: { sdp: "x" },
      }),
    );
    assert.deepEqual(result, {
      type: "offer",
      target_device_id: "device-B",
      payload: { sdp: "x" },
    });
  });

  test("returns null for a relay message missing target_device_id", () => {
    const result = parse_client_message(
      JSON.stringify({ type: "answer", payload: { sdp: "x" } }),
    );
    assert.equal(result, null);
  });

  test("returns null for a relay message missing payload", () => {
    const result = parse_client_message(
      JSON.stringify({ type: "ice-candidate", target_device_id: "device-B" }),
    );
    assert.equal(result, null);
  });
});

describe("handle_connection", () => {
  test("assigns a unique device id per connection", () => {
    const device_a = handle_connection(make_fake_connection());
    const device_b = handle_connection(make_fake_connection());
    assert.notEqual(device_a, device_b);
  });
});

describe("join flow", () => {
  test("joining with no room_code creates a new room", () => {
    const conn = make_fake_connection();
    const device_id = handle_connection(conn);

    handle_client_message(
      device_id,
      JSON.stringify({ type: "join", device_name: "Device A" }),
    );

    assert.equal(conn.messages.length, 1);
    const message = expect_message_type(conn.messages[0], "room-created");
    assert.equal(message.device_id, device_id);
    assert.equal(message.device_name, "Device A");
    assert.equal(typeof message.room_code, "string");
    assert.equal(get_room_code_for_device(device_id), message.room_code);
  });

  test("a second device joining an existing room gets room-joined with the first device listed as a peer, including its name", () => {
    const conn_a = make_fake_connection();
    const device_a = handle_connection(conn_a);
    handle_client_message(
      device_a,
      JSON.stringify({ type: "join", device_name: "Device A" }),
    );
    const room_code = expect_message_type(
      conn_a.messages[0],
      "room-created",
    ).room_code;

    const conn_b = make_fake_connection();
    const device_b = handle_connection(conn_b);
    handle_client_message(
      device_b,
      JSON.stringify({ type: "join", device_name: "Device B", room_code }),
    );

    assert.equal(conn_b.messages.length, 1);
    const joined_message = expect_message_type(
      conn_b.messages[0],
      "room-joined",
    );
    assert.equal(joined_message.room_code, room_code);
    assert.equal(joined_message.device_id, device_b);
    assert.equal(joined_message.device_name, "Device B");
    assert.deepEqual(joined_message.peer_devices, [
      { device_id: device_a, device_name: "Device A" },
    ]);
  });

  test("existing devices in the room are notified when a new peer joins, including its name", () => {
    const conn_a = make_fake_connection();
    const device_a = handle_connection(conn_a);
    handle_client_message(
      device_a,
      JSON.stringify({ type: "join", device_name: "Device A" }),
    );
    const room_code = expect_message_type(
      conn_a.messages[0],
      "room-created",
    ).room_code;

    const conn_b = make_fake_connection();
    const device_b = handle_connection(conn_b);
    handle_client_message(
      device_b,
      JSON.stringify({ type: "join", device_name: "Device B", room_code }),
    );

    assert.equal(conn_a.messages.length, 2);
    const peer_joined_message = expect_message_type(
      conn_a.messages[1],
      "peer-joined",
    );
    assert.equal(peer_joined_message.device_id, device_b);
    assert.equal(peer_joined_message.device_name, "Device B");
  });

  test("joining a room code that doesn't exist sends an error", () => {
    const conn = make_fake_connection();
    const device_id = handle_connection(conn);

    handle_client_message(
      device_id,
      JSON.stringify({
        type: "join",
        device_name: "Device A",
        room_code: "ZZZZZZ",
      }),
    );

    assert.equal(conn.messages.length, 1);
    assert.equal(conn.messages[0].type, "error");
    assert.equal(get_room_code_for_device(device_id), undefined);
  });

  test("a malformed join message (bad room_code type) sends an error, not a crash", () => {
    const conn = make_fake_connection();
    const device_id = handle_connection(conn);

    assert.doesNotThrow(() => {
      handle_client_message(
        device_id,
        JSON.stringify({
          type: "join",
          device_name: "Device A",
          room_code: 123,
        }),
      );
    });
    assert.equal(conn.messages[0].type, "error");
  });
});

describe("device name validation and uniqueness", () => {
  test("rejects an empty device name with a specific error", () => {
    const conn = make_fake_connection();
    const device_id = handle_connection(conn);

    handle_client_message(
      device_id,
      JSON.stringify({ type: "join", device_name: "" }),
    );

    assert.equal(conn.messages.length, 1);
    const message = expect_message_type(conn.messages[0], "error");
    assert.match(message.message, /between 1 and/);
    assert.equal(get_room_code_for_device(device_id), undefined);
  });

  test("rejects a whitespace-only device name", () => {
    const conn = make_fake_connection();
    const device_id = handle_connection(conn);

    handle_client_message(
      device_id,
      JSON.stringify({ type: "join", device_name: "   " }),
    );

    assert.equal(conn.messages[0].type, "error");
    assert.equal(get_room_code_for_device(device_id), undefined);
  });

  test("rejects a device name over the length limit", () => {
    const conn = make_fake_connection();
    const device_id = handle_connection(conn);

    handle_client_message(
      device_id,
      JSON.stringify({ type: "join", device_name: "x".repeat(41) }),
    );

    assert.equal(conn.messages[0].type, "error");
    assert.equal(get_room_code_for_device(device_id), undefined);
  });

  test("trims surrounding whitespace from an otherwise-valid name", () => {
    const conn = make_fake_connection();
    const device_id = handle_connection(conn);

    handle_client_message(
      device_id,
      JSON.stringify({ type: "join", device_name: "  Device A  " }),
    );

    const message = expect_message_type(conn.messages[0], "room-created");
    assert.equal(message.device_name, "Device A");
  });

  test("rejects joining a room under a name already taken there, with a specific error", () => {
    const conn_a = make_fake_connection();
    const device_a = handle_connection(conn_a);
    handle_client_message(
      device_a,
      JSON.stringify({ type: "join", device_name: "Device A" }),
    );
    const room_code = expect_message_type(
      conn_a.messages[0],
      "room-created",
    ).room_code;

    const conn_b = make_fake_connection();
    const device_b = handle_connection(conn_b);
    handle_client_message(
      device_b,
      JSON.stringify({ type: "join", device_name: "Device A", room_code }),
    );

    assert.equal(conn_b.messages.length, 1);
    const message = expect_message_type(conn_b.messages[0], "error");
    assert.match(message.message, /already taken/);
    // Rejected device should not be considered a room member.
    assert.equal(get_room_code_for_device(device_b), undefined);
  });

  test("rejects a name collision case-insensitively", () => {
    const conn_a = make_fake_connection();
    const device_a = handle_connection(conn_a);
    handle_client_message(
      device_a,
      JSON.stringify({ type: "join", device_name: "Device A" }),
    );
    const room_code = expect_message_type(
      conn_a.messages[0],
      "room-created",
    ).room_code;

    const conn_b = make_fake_connection();
    const device_b = handle_connection(conn_b);
    handle_client_message(
      device_b,
      JSON.stringify({ type: "join", device_name: "device a", room_code }),
    );

    const message = expect_message_type(conn_b.messages[0], "error");
    assert.match(message.message, /already taken/);
  });

  test("the same name is allowed again in a room once the original device leaves", () => {
    const conn_a = make_fake_connection();
    const device_a = handle_connection(conn_a);
    handle_client_message(
      device_a,
      JSON.stringify({ type: "join", device_name: "Device A" }),
    );
    const room_code = expect_message_type(
      conn_a.messages[0],
      "room-created",
    ).room_code;

    // A second device keeps the room alive once device_a leaves - if
    // device_a were the only member, leaving would delete the room
    // entirely (existing behavior), leaving nothing for device_c to join.
    const conn_b = make_fake_connection();
    const device_b = handle_connection(conn_b);
    handle_client_message(
      device_b,
      JSON.stringify({ type: "join", device_name: "Device B", room_code }),
    );

    handle_client_message(device_a, JSON.stringify({ type: "leave" }));

    const conn_c = make_fake_connection();
    const device_c = handle_connection(conn_c);
    handle_client_message(
      device_c,
      JSON.stringify({ type: "join", device_name: "Device A", room_code }),
    );

    const message = expect_message_type(conn_c.messages[0], "room-joined");
    assert.equal(message.device_name, "Device A");
  });

  test("the same name is allowed in two different rooms simultaneously", () => {
    const conn_a = make_fake_connection();
    const device_a = handle_connection(conn_a);
    handle_client_message(
      device_a,
      JSON.stringify({ type: "join", device_name: "Device A" }),
    );

    const conn_b = make_fake_connection();
    const device_b = handle_connection(conn_b);
    handle_client_message(
      device_b,
      JSON.stringify({ type: "join", device_name: "Device A" }), // separate room
    );

    expect_message_type(conn_a.messages[0], "room-created");
    expect_message_type(conn_b.messages[0], "room-created");
  });
});

describe("leave flow", () => {
  test("leaving notifies remaining peers (with the leaver's name) and clears the device's room mapping", () => {
    const conn_a = make_fake_connection();
    const device_a = handle_connection(conn_a);
    handle_client_message(
      device_a,
      JSON.stringify({ type: "join", device_name: "Device A" }),
    );
    const room_code = expect_message_type(
      conn_a.messages[0],
      "room-created",
    ).room_code;

    const conn_b = make_fake_connection();
    const device_b = handle_connection(conn_b);
    handle_client_message(
      device_b,
      JSON.stringify({ type: "join", device_name: "Device B", room_code }),
    );

    handle_client_message(device_b, JSON.stringify({ type: "leave" }));

    const peer_left_message = expect_message_type(
      conn_a.messages.at(-1)!,
      "peer-left",
    );
    assert.equal(peer_left_message.device_id, device_b);
    assert.equal(peer_left_message.device_name, "Device B");
    assert.equal(get_room_code_for_device(device_b), undefined);
  });

  test("leaving when not in a room is a harmless no-op", () => {
    const conn = make_fake_connection();
    const device_id = handle_connection(conn);

    assert.doesNotThrow(() => {
      handle_client_message(device_id, JSON.stringify({ type: "leave" }));
    });
    assert.equal(conn.messages.length, 0);
  });
});

describe("offer / answer / ice-candidate relay", () => {
  function set_up_paired_room() {
    const conn_a = make_fake_connection();
    const device_a = handle_connection(conn_a);
    handle_client_message(
      device_a,
      JSON.stringify({ type: "join", device_name: "Device A" }),
    );
    const room_code = expect_message_type(
      conn_a.messages[0],
      "room-created",
    ).room_code;

    const conn_b = make_fake_connection();
    const device_b = handle_connection(conn_b);
    handle_client_message(
      device_b,
      JSON.stringify({ type: "join", device_name: "Device B", room_code }),
    );

    // Clear the join-time messages so relay tests start with a clean slate.
    conn_a.messages.length = 0;
    conn_b.messages.length = 0;

    return { conn_a, device_a, conn_b, device_b, room_code };
  }

  test("relays an offer to the target device with the sender's id attached", () => {
    const { conn_b, device_a, device_b } = set_up_paired_room();

    handle_client_message(
      device_a,
      JSON.stringify({
        type: "offer",
        target_device_id: device_b,
        payload: { sdp: "offer-sdp" },
      }),
    );

    assert.equal(conn_b.messages.length, 1);
    const message = expect_message_type(conn_b.messages[0], "offer");
    assert.equal(message.from_device_id, device_a);
    assert.deepEqual(message.payload, { sdp: "offer-sdp" });
  });

  test("relays an answer to the target device with the sender's id attached", () => {
    const { conn_a, device_a, device_b } = set_up_paired_room();

    handle_client_message(
      device_b,
      JSON.stringify({
        type: "answer",
        target_device_id: device_a,
        payload: { sdp: "answer-sdp" },
      }),
    );

    assert.equal(conn_a.messages.length, 1);
    const message = expect_message_type(conn_a.messages[0], "answer");
    assert.equal(message.from_device_id, device_b);
    assert.deepEqual(message.payload, { sdp: "answer-sdp" });
  });

  test("relays an ice-candidate to the target device with the sender's id attached", () => {
    const { conn_b, device_a, device_b } = set_up_paired_room();

    handle_client_message(
      device_a,
      JSON.stringify({
        type: "ice-candidate",
        target_device_id: device_b,
        payload: { candidate: "fake-candidate" },
      }),
    );

    assert.equal(conn_b.messages.length, 1);
    const message = expect_message_type(conn_b.messages[0], "ice-candidate");
    assert.equal(message.from_device_id, device_a);
  });

  test("rejects a relay to a device outside the sender's room", () => {
    const { conn_a, device_a } = set_up_paired_room();

    const conn_c = make_fake_connection();
    const device_c = handle_connection(conn_c);
    // device_c never joins a room at all.

    handle_client_message(
      device_a,
      JSON.stringify({
        type: "offer",
        target_device_id: device_c,
        payload: {},
      }),
    );

    assert.equal(conn_a.messages.length, 1);
    assert.equal(conn_a.messages[0].type, "error");
    // The device outside the room should never have received anything.
    assert.equal(conn_c.messages.length, 0);
  });

  test("rejects a relay attempt from a device that isn't in any room", () => {
    const conn = make_fake_connection();
    const device_id = handle_connection(conn);

    handle_client_message(
      device_id,
      JSON.stringify({
        type: "offer",
        target_device_id: "some-other-device",
        payload: {},
      }),
    );

    assert.equal(conn.messages.length, 1);
    assert.equal(conn.messages[0].type, "error");
  });

  test("rejects a relay between two devices in two different rooms", () => {
    const conn_a = make_fake_connection();
    const device_a = handle_connection(conn_a);
    handle_client_message(
      device_a,
      JSON.stringify({ type: "join", device_name: "Device A" }),
    );

    const conn_b = make_fake_connection();
    const device_b = handle_connection(conn_b);
    handle_client_message(
      device_b,
      JSON.stringify({ type: "join", device_name: "Device B" }), // separate room
    );

    conn_a.messages.length = 0;

    handle_client_message(
      device_a,
      JSON.stringify({
        type: "offer",
        target_device_id: device_b,
        payload: {},
      }),
    );

    assert.equal(conn_a.messages[0].type, "error");
  });
});

describe("malformed message handling", () => {
  test("invalid JSON produces an error response instead of throwing", () => {
    const conn = make_fake_connection();
    const device_id = handle_connection(conn);

    assert.doesNotThrow(() => handle_client_message(device_id, "not json"));
    assert.equal(conn.messages.length, 1);
    assert.equal(conn.messages[0].type, "error");
  });

  test("an unknown message type produces an error response", () => {
    const conn = make_fake_connection();
    const device_id = handle_connection(conn);

    handle_client_message(device_id, JSON.stringify({ type: "self-destruct" }));

    assert.equal(conn.messages[0].type, "error");
  });

  test("rejects a raw message over the size limit with a specific error, without attempting to parse it", () => {
    const conn = make_fake_connection();
    const device_id = handle_connection(conn);

    // Oversized but otherwise well-formed JSON - if the size guard weren't
    // firing first, this would parse fine and hit "malformed message" or
    // succeed, not the size-specific error.
    const oversized = JSON.stringify({
      type: "join",
      device_name: "x".repeat(100_000),
    });

    handle_client_message(device_id, oversized);

    assert.equal(conn.messages.length, 1);
    const message = conn.messages[0];
    assert.equal(message.type, "error");
    assert.match((message as { message: string }).message, /too large/);
  });

  test("a normal-sized message is unaffected by the size guard", () => {
    const conn = make_fake_connection();
    const device_id = handle_connection(conn);

    const raw = JSON.stringify({ type: "join", device_name: "Device A" });

    assert.doesNotThrow(() => handle_client_message(device_id, raw));
    assert.equal(conn.messages[0].type, "room-created");
  });
});

describe("handle_disconnect", () => {
  test("notifies remaining peers, including the disconnected device's name", () => {
    const conn_a = make_fake_connection();
    const device_a = handle_connection(conn_a);
    handle_client_message(
      device_a,
      JSON.stringify({ type: "join", device_name: "Device A" }),
    );
    const room_code = expect_message_type(
      conn_a.messages[0],
      "room-created",
    ).room_code;

    const conn_b = make_fake_connection();
    const device_b = handle_connection(conn_b);
    handle_client_message(
      device_b,
      JSON.stringify({ type: "join", device_name: "Device B", room_code }),
    );

    handle_disconnect(device_b);

    const peer_left_message = expect_message_type(
      conn_a.messages.at(-1)!,
      "peer-left",
    );
    assert.equal(peer_left_message.device_id, device_b);
    assert.equal(peer_left_message.device_name, "Device B");
  });

  test("clears the disconnected device's room mapping", () => {
    const conn = make_fake_connection();
    const device_id = handle_connection(conn);
    handle_client_message(
      device_id,
      JSON.stringify({ type: "join", device_name: "Device A" }),
    );

    handle_disconnect(device_id);

    assert.equal(get_room_code_for_device(device_id), undefined);
  });

  test("is a harmless no-op for a device that was never in a room", () => {
    const conn = make_fake_connection();
    const device_id = handle_connection(conn);

    assert.doesNotThrow(() => handle_disconnect(device_id));
  });

  test("a disconnected device's connection no longer receives relayed messages", () => {
    const conn_a = make_fake_connection();
    const device_a = handle_connection(conn_a);
    handle_client_message(
      device_a,
      JSON.stringify({ type: "join", device_name: "Device A" }),
    );
    const room_code = expect_message_type(
      conn_a.messages[0],
      "room-created",
    ).room_code;

    const conn_b = make_fake_connection();
    const device_b = handle_connection(conn_b);
    handle_client_message(
      device_b,
      JSON.stringify({ type: "join", device_name: "Device B", room_code }),
    );

    handle_disconnect(device_b);
    conn_b.messages.length = 0;

    // device_a tries to relay to the now-disconnected device_b. Since
    // device_b's room mapping was cleared, this should error rather than
    // silently vanish into a dead connection.
    handle_client_message(
      device_a,
      JSON.stringify({
        type: "offer",
        target_device_id: device_b,
        payload: {},
      }),
    );

    assert.equal(conn_b.messages.length, 0);
  });
});

describe("notify_rooms_expired", () => {
  test("sends room-expired to every device listed in an evicted room", () => {
    const conn_a = make_fake_connection();
    const device_a = handle_connection(conn_a);
    const conn_b = make_fake_connection();
    const device_b = handle_connection(conn_b);

    notify_rooms_expired([
      { room_code: "ABC123", device_ids: [device_a, device_b] },
    ]);

    assert.equal(conn_a.messages.length, 1);
    assert.equal(conn_b.messages.length, 1);
    assert.equal(
      expect_message_type(conn_a.messages[0], "room-expired").room_code,
      "ABC123",
    );
    assert.equal(
      expect_message_type(conn_b.messages[0], "room-expired").room_code,
      "ABC123",
    );
  });

  test("clears the room mapping for every notified device", () => {
    const conn = make_fake_connection();
    const device_id = handle_connection(conn);
    handle_client_message(
      device_id,
      JSON.stringify({ type: "join", device_name: "Device A" }),
    );
    const room_code = expect_message_type(
      conn.messages[0],
      "room-created",
    ).room_code;

    notify_rooms_expired([{ room_code, device_ids: [device_id] }]);

    assert.equal(get_room_code_for_device(device_id), undefined);
  });

  test("does not close or otherwise disturb the device's connection", () => {
    const conn = make_fake_connection();
    const device_id = handle_connection(conn);

    notify_rooms_expired([{ room_code: "ABC123", device_ids: [device_id] }]);

    // The device should still be reachable for further messages - a
    // second notification (or any other send) should still land.
    notify_rooms_expired([{ room_code: "ABC123", device_ids: [device_id] }]);
    assert.equal(conn.messages.length, 2);
  });

  test("handles multiple evicted rooms in one call, notifying only the devices in each", () => {
    const conn_a = make_fake_connection();
    const device_a = handle_connection(conn_a);
    const conn_b = make_fake_connection();
    const device_b = handle_connection(conn_b);

    notify_rooms_expired([
      { room_code: "ROOM01", device_ids: [device_a] },
      { room_code: "ROOM02", device_ids: [device_b] },
    ]);

    assert.equal(conn_a.messages.length, 1);
    assert.equal(
      expect_message_type(conn_a.messages[0], "room-expired").room_code,
      "ROOM01",
    );
    assert.equal(conn_b.messages.length, 1);
    assert.equal(
      expect_message_type(conn_b.messages[0], "room-expired").room_code,
      "ROOM02",
    );
  });

  test("is a harmless no-op when given an empty list", () => {
    assert.doesNotThrow(() => notify_rooms_expired([]));
  });

  test("does not throw when a device id has no live connection", () => {
    // Simulates a device that disconnected between the sweep capturing
    // its id and notify_rooms_expired running - send_to_device's existing
    // not-found handling should just silently skip it.
    assert.doesNotThrow(() =>
      notify_rooms_expired([
        { room_code: "ABC123", device_ids: ["ghost-device-id"] },
      ]),
    );
  });
});
