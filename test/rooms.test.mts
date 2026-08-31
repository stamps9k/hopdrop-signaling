import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  create_room,
  add_device_to_room,
  remove_device_from_room,
  get_devices_in_room,
  get_device_name,
  room_exists,
  get_room_is_turn,
  get_cached_ice_servers,
  cache_ice_servers,
  evict_room,
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
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    assert.equal(room_exists(room_code, BASE_TIME), true);
    assert.deepEqual(get_devices_in_room(room_code, BASE_TIME), ["device-A"]);
  });

  test("stores the first device's name", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    assert.equal(get_device_name(room_code, "device-A", BASE_TIME), "Name A");
  });

  test("generates a well-formed room code", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    assert.equal(room_code.length, 6);
  });

  test("generates distinct codes for distinct rooms", () => {
    const code_a = create_room("device-A", "Name A", false, BASE_TIME);
    const code_b = create_room("device-B", "Name B", false, BASE_TIME);
    assert.notEqual(code_a, code_b);
  });
});

describe("add_device_to_room", () => {
  test("adds a second device to an existing room", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    const result = add_device_to_room(
      room_code,
      "device-B",
      "Name B",
      false,
      BASE_TIME,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(get_devices_in_room(room_code, BASE_TIME).sort(), [
      "device-A",
      "device-B",
    ]);
  });

  test("stores the joining device's name", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    add_device_to_room(room_code, "device-B", "Name B", false, BASE_TIME);
    assert.equal(get_device_name(room_code, "device-B", BASE_TIME), "Name B");
  });

  test("rejects a join to a room that doesn't exist", () => {
    const result = add_device_to_room(
      "ZZZZZZ",
      "device-B",
      "Name B",
      false,
      BASE_TIME,
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "room_not_found");
  });

  test("rejects a malformed room code", () => {
    const result = add_device_to_room(
      "bad",
      "device-B",
      "Name B",
      false,
      BASE_TIME,
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "room_not_found");
  });

  test("rejects a join to a room that has already expired", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    const after_expiry = BASE_TIME + ROOM_TTL_MS + 1;
    const result = add_device_to_room(
      room_code,
      "device-B",
      "Name B",
      false,
      after_expiry,
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "room_not_found");
  });

  test("refreshes the room's TTL on join", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);

    // Join just before the original TTL would have expired.
    const just_before_expiry = BASE_TIME + ROOM_TTL_MS - 1;
    const result = add_device_to_room(
      room_code,
      "device-B",
      "Name B",
      false,
      just_before_expiry,
    );
    assert.equal(result.ok, true);

    // Room should still be alive past the *original* expiry point, since
    // joining should have pushed expires_at forward from just_before_expiry.
    const past_original_expiry = BASE_TIME + ROOM_TTL_MS + 1;
    assert.equal(room_exists(room_code, past_original_expiry), true);
  });

  describe("name uniqueness", () => {
    test("rejects an exact-duplicate name already in the room", () => {
      const room_code = create_room(
        "device-A",
        "Sam's Laptop",
        false,
        BASE_TIME,
      );
      const result = add_device_to_room(
        room_code,
        "device-B",
        "Sam's Laptop",
        false,
        BASE_TIME,
      );
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.reason, "name_taken");
      // Rejected device should not have been added.
      assert.deepEqual(get_devices_in_room(room_code, BASE_TIME), ["device-A"]);
    });

    test("rejects a name differing only by case", () => {
      const room_code = create_room(
        "device-A",
        "Sam's Laptop",
        false,
        BASE_TIME,
      );
      const result = add_device_to_room(
        room_code,
        "device-B",
        "sam's laptop",
        false,
        BASE_TIME,
      );
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.reason, "name_taken");
    });

    test("rejects a name differing only by surrounding whitespace", () => {
      const room_code = create_room(
        "device-A",
        "Sam's Laptop",
        false,
        BASE_TIME,
      );
      const result = add_device_to_room(
        room_code,
        "device-B",
        "  Sam's Laptop  ",
        false,
        BASE_TIME,
      );
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.reason, "name_taken");
    });

    test("allows the same name in two different rooms", () => {
      const room_a = create_room("device-A", "Same Name", false, BASE_TIME);
      const room_b = create_room("device-C", "Other", false, BASE_TIME);
      const result = add_device_to_room(
        room_b,
        "device-D",
        "Same Name",
        false,
        BASE_TIME,
      );
      assert.equal(result.ok, true);
      // Sanity: room_a untouched by the room_b join.
      assert.deepEqual(get_devices_in_room(room_a, BASE_TIME), ["device-A"]);
    });

    test("allows distinct names in the same room", () => {
      const room_code = create_room("device-A", "Name A", false, BASE_TIME);
      const result = add_device_to_room(
        room_code,
        "device-B",
        "Name B",
        false,
        BASE_TIME,
      );
      assert.equal(result.ok, true);
    });
  });

  describe("is_turn enforcement", () => {
    test("accepts a join whose is_turn matches the room's stored value (true)", () => {
      const room_code = create_room("device-A", "Name A", true, BASE_TIME);
      const result = add_device_to_room(
        room_code,
        "device-B",
        "Name B",
        true,
        BASE_TIME,
      );
      assert.equal(result.ok, true);
    });

    test("accepts a join whose is_turn matches the room's stored value (false)", () => {
      const room_code = create_room("device-A", "Name A", false, BASE_TIME);
      const result = add_device_to_room(
        room_code,
        "device-B",
        "Name B",
        false,
        BASE_TIME,
      );
      assert.equal(result.ok, true);
    });

    test("rejects a join whose is_turn is true against a false room", () => {
      const room_code = create_room("device-A", "Name A", false, BASE_TIME);
      const result = add_device_to_room(
        room_code,
        "device-B",
        "Name B",
        true,
        BASE_TIME,
      );
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.reason, "is_turn_mismatch");
      // Rejected device should not have been added.
      assert.deepEqual(get_devices_in_room(room_code, BASE_TIME), ["device-A"]);
    });

    test("rejects a join whose is_turn is false against a true room", () => {
      const room_code = create_room("device-A", "Name A", true, BASE_TIME);
      const result = add_device_to_room(
        room_code,
        "device-B",
        "Name B",
        false,
        BASE_TIME,
      );
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.reason, "is_turn_mismatch");
    });

    test("is_turn_mismatch takes priority over name_taken when both would apply", () => {
      const room_code = create_room("device-A", "Same Name", false, BASE_TIME);
      const result = add_device_to_room(
        room_code,
        "device-B",
        "Same Name",
        true,
        BASE_TIME,
      );
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.reason, "is_turn_mismatch");
    });
  });
});

describe("get_device_name", () => {
  test("returns the device's stored name", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    assert.equal(get_device_name(room_code, "device-A", BASE_TIME), "Name A");
  });

  test("returns undefined for a room that doesn't exist", () => {
    assert.equal(get_device_name("ZZZZZZ", "device-A", BASE_TIME), undefined);
  });

  test("returns undefined for a device not in the room", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    assert.equal(
      get_device_name(room_code, "device-not-present", BASE_TIME),
      undefined,
    );
  });

  test("returns undefined for a room that has expired", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    const after_expiry = BASE_TIME + ROOM_TTL_MS + 1;
    assert.equal(
      get_device_name(room_code, "device-A", after_expiry),
      undefined,
    );
  });

  test("does not itself refresh the room's TTL", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    const just_before_expiry = BASE_TIME + ROOM_TTL_MS - 1;

    get_device_name(room_code, "device-A", just_before_expiry);

    const after_original_expiry = BASE_TIME + ROOM_TTL_MS + 1;
    assert.equal(room_exists(room_code, after_original_expiry), false);
  });
});

describe("remove_device_from_room", () => {
  test("removes a device but keeps the room alive if others remain", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    add_device_to_room(room_code, "device-B", "Name B", false, BASE_TIME);

    remove_device_from_room(room_code, "device-A");

    assert.equal(room_exists(room_code, BASE_TIME), true);
    assert.deepEqual(get_devices_in_room(room_code, BASE_TIME), ["device-B"]);
  });

  test("frees up the removed device's name for reuse in the same still-alive room", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    add_device_to_room(room_code, "device-B", "Name B", false, BASE_TIME);

    remove_device_from_room(room_code, "device-A");

    const result = add_device_to_room(
      room_code,
      "device-C",
      "Name A",
      false,
      BASE_TIME,
    );
    assert.equal(result.ok, true);
    assert.equal(get_device_name(room_code, "device-C", BASE_TIME), "Name A");
  });

  test("deletes the room once the last device leaves", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    remove_device_from_room(room_code, "device-A");
    assert.equal(room_exists(room_code, BASE_TIME), false);
  });

  test("is a no-op for a room that doesn't exist", () => {
    assert.doesNotThrow(() => remove_device_from_room("ZZZZZZ", "device-A"));
  });

  test("is a no-op for a device that isn't in the room", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    remove_device_from_room(room_code, "device-not-present");
    assert.equal(room_exists(room_code, BASE_TIME), true);
    assert.deepEqual(get_devices_in_room(room_code, BASE_TIME), ["device-A"]);
  });
});

describe("get_devices_in_room", () => {
  test("returns an empty array for a room that doesn't exist", () => {
    assert.deepEqual(get_devices_in_room("ZZZZZZ", BASE_TIME), []);
  });

  test("returns an empty array for a room that has expired", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    const after_expiry = BASE_TIME + ROOM_TTL_MS + 1;
    assert.deepEqual(get_devices_in_room(room_code, after_expiry), []);
  });

  test("does not itself refresh the room's TTL", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    const just_before_expiry = BASE_TIME + ROOM_TTL_MS - 1;

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
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    const exact_expiry = BASE_TIME + ROOM_TTL_MS;
    assert.equal(room_exists(room_code, exact_expiry - 1), true);
    assert.equal(room_exists(room_code, exact_expiry), false);
  });
});

describe("get_room_is_turn", () => {
  test("returns true for a room created with is_turn true", () => {
    const room_code = create_room("device-A", "Name A", true, BASE_TIME);
    assert.equal(get_room_is_turn(room_code, BASE_TIME), true);
  });

  test("returns false for a room created with is_turn false", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    assert.equal(get_room_is_turn(room_code, BASE_TIME), false);
  });

  test("returns undefined for a room that doesn't exist", () => {
    assert.equal(get_room_is_turn("ZZZZZZ", BASE_TIME), undefined);
  });

  test("returns undefined for a room that has expired", () => {
    const room_code = create_room("device-A", "Name A", true, BASE_TIME);
    const after_expiry = BASE_TIME + ROOM_TTL_MS + 1;
    assert.equal(get_room_is_turn(room_code, after_expiry), undefined);
  });

  test("does not itself refresh the room's TTL", () => {
    const room_code = create_room("device-A", "Name A", true, BASE_TIME);
    const just_before_expiry = BASE_TIME + ROOM_TTL_MS - 1;

    get_room_is_turn(room_code, just_before_expiry);

    const after_original_expiry = BASE_TIME + ROOM_TTL_MS + 1;
    assert.equal(room_exists(room_code, after_original_expiry), false);
  });
});

describe("get_cached_ice_servers / cache_ice_servers", () => {
  test("returns not_cached for a room with nothing cached yet", () => {
    const room_code = create_room("device-A", "Name A", true, BASE_TIME);
    const result = get_cached_ice_servers(room_code, BASE_TIME);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "not_cached");
  });

  test("returns room_not_found for a room that doesn't exist", () => {
    const result = get_cached_ice_servers("ZZZZZZ", BASE_TIME);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "room_not_found");
  });

  test("returns room_not_found for a room that has expired", () => {
    const room_code = create_room("device-A", "Name A", true, BASE_TIME);
    const after_expiry = BASE_TIME + ROOM_TTL_MS + 1;
    const result = get_cached_ice_servers(room_code, after_expiry);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "room_not_found");
  });

  test("returns cached credentials once cache_ice_servers has been called", () => {
    const room_code = create_room("device-A", "Name A", true, BASE_TIME);
    const fake_ice_servers = [
      { urls: "turn:example.com", username: "u", credential: "p" },
    ];

    cache_ice_servers(room_code, fake_ice_servers);

    const result = get_cached_ice_servers(room_code, BASE_TIME);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.ice_servers, fake_ice_servers);
  });

  test("cache_ice_servers is a no-op for a room that doesn't exist", () => {
    assert.doesNotThrow(() =>
      cache_ice_servers("ZZZZZZ", [{ urls: "turn:x" }]),
    );
  });

  test("a later cache_ice_servers call overwrites an earlier cached value", () => {
    const room_code = create_room("device-A", "Name A", true, BASE_TIME);

    cache_ice_servers(room_code, [{ urls: "turn:first.example.com" }]);
    cache_ice_servers(room_code, [{ urls: "turn:second.example.com" }]);

    const result = get_cached_ice_servers(room_code, BASE_TIME);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.ice_servers, [
      { urls: "turn:second.example.com" },
    ]);
  });

  test("caching does not refresh the room's TTL", () => {
    const room_code = create_room("device-A", "Name A", true, BASE_TIME);
    cache_ice_servers(room_code, [{ urls: "turn:ignored.example.com" }]);
    const after_expiry = BASE_TIME + ROOM_TTL_MS + 1;
    assert.equal(room_exists(room_code, after_expiry), false);
  });
});

describe("evict_room", () => {
  test("deletes the room and returns its room_code and device_ids", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    add_device_to_room(room_code, "device-B", "Name B", false, BASE_TIME);

    const evicted = evict_room(room_code);

    assert.ok(evicted);
    assert.equal(evicted?.room_code, room_code);
    assert.deepEqual(evicted?.device_ids.sort(), ["device-A", "device-B"]);
    assert.equal(room_exists(room_code, BASE_TIME), false);
  });

  test("returns null for a room that doesn't exist", () => {
    assert.equal(evict_room("ZZZZZZ"), null);
  });

  test("evicts a room regardless of its remaining TTL", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    evict_room(room_code);
    assert.equal(room_exists(room_code, BASE_TIME), false);
  });

  test("does not affect other rooms", () => {
    const room_a = create_room("device-A", "Name A", false, BASE_TIME);
    const room_b = create_room("device-B", "Name B", false, BASE_TIME);

    evict_room(room_a);

    assert.equal(room_exists(room_a, BASE_TIME), false);
    assert.equal(room_exists(room_b, BASE_TIME), true);
  });
});

describe("cleanup_expired_rooms", () => {
  test("removes only expired rooms, leaving live rooms untouched", () => {
    const expiring_room = create_room("device-A", "Name A", false, BASE_TIME);
    const later_time = BASE_TIME + ROOM_TTL_MS - 1000;
    const live_room = create_room("device-B", "Name B", false, later_time);

    const sweep_time = BASE_TIME + ROOM_TTL_MS + 1;
    const evicted_rooms = cleanup_expired_rooms(sweep_time);

    assert.equal(evicted_rooms.length, 1);
    assert.equal(evicted_rooms[0].room_code, expiring_room);
    assert.equal(room_exists(expiring_room, sweep_time), false);
    assert.equal(room_exists(live_room, sweep_time), true);
  });

  test("includes the device ids that were in each evicted room", () => {
    const room_code = create_room("device-A", "Name A", false, BASE_TIME);
    add_device_to_room(room_code, "device-B", "Name B", false, BASE_TIME);

    const sweep_time = BASE_TIME + ROOM_TTL_MS + 1;
    const evicted_rooms = cleanup_expired_rooms(sweep_time);

    assert.equal(evicted_rooms.length, 1);
    assert.deepEqual(evicted_rooms[0].device_ids.sort(), [
      "device-A",
      "device-B",
    ]);
  });

  test("returns one entry per evicted room when multiple rooms expire in the same sweep", () => {
    const room_a = create_room("device-A", "Name A", false, BASE_TIME);
    const room_b = create_room("device-B", "Name B", false, BASE_TIME);

    const sweep_time = BASE_TIME + ROOM_TTL_MS + 1;
    const evicted_rooms = cleanup_expired_rooms(sweep_time);

    assert.equal(evicted_rooms.length, 2);
    const evicted_codes = evicted_rooms.map((room) => room.room_code).sort();
    assert.deepEqual(evicted_codes, [room_a, room_b].sort());
  });

  test("returns an empty array when nothing is expired", () => {
    create_room("device-A", "Name A", false, BASE_TIME);
    const evicted_rooms = cleanup_expired_rooms(BASE_TIME);
    assert.deepEqual(evicted_rooms, []);
  });

  test("returns an empty array when there are no rooms at all", () => {
    const evicted_rooms = cleanup_expired_rooms(BASE_TIME);
    assert.deepEqual(evicted_rooms, []);
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
    assert.doesNotThrow(() => {
      start_room_cleanup();
      start_room_cleanup();
      stop_room_cleanup();
    });
  });

  test("stop is safe to call when never started", () => {
    assert.doesNotThrow(() => stop_room_cleanup());
  });

  test("accepts an on_rooms_expired callback without throwing", () => {
    assert.doesNotThrow(() => {
      start_room_cleanup(() => {});
      stop_room_cleanup();
    });
  });
});
