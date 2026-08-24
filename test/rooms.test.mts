import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  create_room,
  add_device_to_room,
  remove_device_from_room,
  get_devices_in_room,
  room_exists,
  cleanup_expired_rooms,
  start_room_cleanup,
  stop_room_cleanup,
  clear_all_rooms,
} from "../src/rooms.mjs";

const ROOM_TTL_MS = 5 * 60 * 1000;
const BASE_TIME = 1_700_000_000_000; // fixed reference point, not wall-clock time

// rooms.mts holds module-level state shared across every test in this file,
// so each test needs a clean slate to avoid bleeding state between cases.
beforeEach(() => {
  clear_all_rooms();
});

describe("create_room", () => {
  test("creates a room and adds the first device to it", () => {
    const room_code = create_room("device-A", BASE_TIME);
    assert.equal(room_exists(room_code, BASE_TIME), true);
    assert.deepEqual(get_devices_in_room(room_code, BASE_TIME), ["device-A"]);
  });

  test("generates a well-formed room code", () => {
    const room_code = create_room("device-A", BASE_TIME);
    assert.equal(room_code.length, 6);
  });

  test("generates distinct codes for distinct rooms", () => {
    const code_a = create_room("device-A", BASE_TIME);
    const code_b = create_room("device-B", BASE_TIME);
    assert.notEqual(code_a, code_b);
  });
});

describe("add_device_to_room", () => {
  test("adds a second device to an existing room", () => {
    const room_code = create_room("device-A", BASE_TIME);
    const joined = add_device_to_room(room_code, "device-B", BASE_TIME);
    assert.equal(joined, true);
    assert.deepEqual(get_devices_in_room(room_code, BASE_TIME).sort(), [
      "device-A",
      "device-B",
    ]);
  });

  test("rejects a join to a room that doesn't exist", () => {
    const joined = add_device_to_room("ZZZZZZ", "device-B", BASE_TIME);
    assert.equal(joined, false);
  });

  test("rejects a malformed room code", () => {
    const joined = add_device_to_room("bad", "device-B", BASE_TIME);
    assert.equal(joined, false);
  });

  test("rejects a join to a room that has already expired", () => {
    const room_code = create_room("device-A", BASE_TIME);
    const after_expiry = BASE_TIME + ROOM_TTL_MS + 1;
    const joined = add_device_to_room(room_code, "device-B", after_expiry);
    assert.equal(joined, false);
  });

  test("refreshes the room's TTL on join", () => {
    const room_code = create_room("device-A", BASE_TIME);

    // Join just before the original TTL would have expired.
    const just_before_expiry = BASE_TIME + ROOM_TTL_MS - 1;
    const joined = add_device_to_room(room_code, "device-B", just_before_expiry);
    assert.equal(joined, true);

    // Room should still be alive past the *original* expiry point, since
    // joining should have pushed expires_at forward from just_before_expiry.
    const past_original_expiry = BASE_TIME + ROOM_TTL_MS + 1;
    assert.equal(room_exists(room_code, past_original_expiry), true);
  });
});

describe("remove_device_from_room", () => {
  test("removes a device but keeps the room alive if others remain", () => {
    const room_code = create_room("device-A", BASE_TIME);
    add_device_to_room(room_code, "device-B", BASE_TIME);

    remove_device_from_room(room_code, "device-A");

    assert.equal(room_exists(room_code, BASE_TIME), true);
    assert.deepEqual(get_devices_in_room(room_code, BASE_TIME), ["device-B"]);
  });

  test("deletes the room once the last device leaves", () => {
    const room_code = create_room("device-A", BASE_TIME);
    remove_device_from_room(room_code, "device-A");
    assert.equal(room_exists(room_code, BASE_TIME), false);
  });

  test("is a no-op for a room that doesn't exist", () => {
    assert.doesNotThrow(() => remove_device_from_room("ZZZZZZ", "device-A"));
  });

  test("is a no-op for a device that isn't in the room", () => {
    const room_code = create_room("device-A", BASE_TIME);
    remove_device_from_room(room_code, "device-not-present");
    // Room should be unaffected: still exists, original device still in it.
    assert.equal(room_exists(room_code, BASE_TIME), true);
    assert.deepEqual(get_devices_in_room(room_code, BASE_TIME), ["device-A"]);
  });
});

describe("get_devices_in_room", () => {
  test("returns an empty array for a room that doesn't exist", () => {
    assert.deepEqual(get_devices_in_room("ZZZZZZ", BASE_TIME), []);
  });

  test("returns an empty array for a room that has expired", () => {
    const room_code = create_room("device-A", BASE_TIME);
    const after_expiry = BASE_TIME + ROOM_TTL_MS + 1;
    assert.deepEqual(get_devices_in_room(room_code, after_expiry), []);
  });

  test("does not itself refresh the room's TTL", () => {
    const room_code = create_room("device-A", BASE_TIME);
    const just_before_expiry = BASE_TIME + ROOM_TTL_MS - 1;

    // Merely reading devices should NOT count as activity.
    get_devices_in_room(room_code, just_before_expiry);

    const after_original_expiry = BASE_TIME + ROOM_TTL_MS + 1;
    assert.equal(room_exists(room_code, after_original_expiry), false);
  });
});

describe("room_exists", () => {
  test("returns false for an unknown room code", () => {
    assert.equal(room_exists("ZZZZZZ", BASE_TIME), false);
  });

  test("returns true up to and excluding the exact expiry timestamp", () => {
    const room_code = create_room("device-A", BASE_TIME);
    const exact_expiry = BASE_TIME + ROOM_TTL_MS;
    assert.equal(room_exists(room_code, exact_expiry - 1), true);
    assert.equal(room_exists(room_code, exact_expiry), false);
  });
});

describe("cleanup_expired_rooms", () => {
  test("removes only expired rooms, leaving live rooms untouched", () => {
    const expiring_room = create_room("device-A", BASE_TIME);
    const later_time = BASE_TIME + ROOM_TTL_MS - 1000;
    const live_room = create_room("device-B", later_time);

    const sweep_time = BASE_TIME + ROOM_TTL_MS + 1;
    const removed_count = cleanup_expired_rooms(sweep_time);

    assert.equal(removed_count, 1);
    assert.equal(room_exists(expiring_room, sweep_time), false);
    assert.equal(room_exists(live_room, sweep_time), true);
  });

  test("returns 0 when nothing is expired", () => {
    create_room("device-A", BASE_TIME);
    const removed_count = cleanup_expired_rooms(BASE_TIME);
    assert.equal(removed_count, 0);
  });

  test("returns 0 when there are no rooms at all", () => {
    const removed_count = cleanup_expired_rooms(BASE_TIME);
    assert.equal(removed_count, 0);
  });
});

describe("start_room_cleanup / stop_room_cleanup", () => {
  test("can be started and stopped without throwing", () => {
    assert.doesNotThrow(() => {
      start_room_cleanup();
      stop_room_cleanup();
    });
  });

  test("calling start twice does not create duplicate timers", () => {
    // No direct way to inspect the timer count from outside the module;
    // this just guards against start_room_cleanup throwing or misbehaving
    // when called repeatedly, e.g. from an accidental double server-boot.
    assert.doesNotThrow(() => {
      start_room_cleanup();
      start_room_cleanup();
      stop_room_cleanup();
    });
  });

  test("stop is safe to call when never started", () => {
    assert.doesNotThrow(() => stop_room_cleanup());
  });
});
