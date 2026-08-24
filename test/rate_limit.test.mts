import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  try_accept_connection,
  release_connection,
  get_active_connection_count,
  extract_client_ip,
  cleanup_stale_ip_state,
  start_rate_limit_cleanup,
  stop_rate_limit_cleanup,
  clear_all_rate_limit_state,
} from "../src/rate_limit.mjs";

// Mirrors the internal constants in rate_limit.mts. Not exported, so kept
// in sync here manually — if the source constants change, these tests
// should be updated to match.
const CONNECTION_RATE_WINDOW_MS = 60 * 1000;
const MAX_CONNECTION_ATTEMPTS_PER_WINDOW = 20;
const MAX_CONCURRENT_CONNECTIONS_PER_IP = 5;

const BASE_TIME = 1_700_000_000_000; // fixed reference point, not wall-clock time

// rate_limit.mts holds module-level state shared across every test in
// this file, so each test needs a clean slate.
beforeEach(() => {
  clear_all_rate_limit_state();
});

describe("try_accept_connection — concurrent cap", () => {
  test("accepts connections up to the concurrent cap", () => {
    for (let i = 0; i < MAX_CONCURRENT_CONNECTIONS_PER_IP; i++) {
      assert.equal(try_accept_connection("1.2.3.4", BASE_TIME), true);
    }
  });

  test("rejects a connection beyond the concurrent cap", () => {
    for (let i = 0; i < MAX_CONCURRENT_CONNECTIONS_PER_IP; i++) {
      try_accept_connection("1.2.3.4", BASE_TIME);
    }
    assert.equal(try_accept_connection("1.2.3.4", BASE_TIME), false);
  });

  test("accepts a new connection again after one is released", () => {
    for (let i = 0; i < MAX_CONCURRENT_CONNECTIONS_PER_IP; i++) {
      try_accept_connection("1.2.3.4", BASE_TIME);
    }
    release_connection("1.2.3.4");
    assert.equal(try_accept_connection("1.2.3.4", BASE_TIME), true);
  });

  test("tracks concurrent connections independently per IP", () => {
    for (let i = 0; i < MAX_CONCURRENT_CONNECTIONS_PER_IP; i++) {
      try_accept_connection("1.1.1.1", BASE_TIME);
    }
    // A different IP should be unaffected by 1.1.1.1 being at its cap.
    assert.equal(try_accept_connection("2.2.2.2", BASE_TIME), true);
  });
});

describe("try_accept_connection — rate window", () => {
  test("accepts up to the max attempts within the window", () => {
    for (let i = 0; i < MAX_CONNECTION_ATTEMPTS_PER_WINDOW; i++) {
      // Release immediately so the concurrent cap never interferes —
      // this test is isolating the rate-window behavior specifically.
      const accepted = try_accept_connection("3.3.3.3", BASE_TIME);
      if (accepted) release_connection("3.3.3.3");
    }
    // All should have been accepted since the concurrent cap was never
    // allowed to fill up (released after every accept).
    assert.equal(get_active_connection_count("3.3.3.3"), 0);
  });

  test("rejects an attempt once the window's attempt cap is exceeded", () => {
    for (let i = 0; i < MAX_CONNECTION_ATTEMPTS_PER_WINDOW; i++) {
      const accepted = try_accept_connection("4.4.4.4", BASE_TIME);
      if (accepted) release_connection("4.4.4.4");
    }
    assert.equal(try_accept_connection("4.4.4.4", BASE_TIME), false);
  });

  test("allows attempts again once the window has fully elapsed", () => {
    for (let i = 0; i < MAX_CONNECTION_ATTEMPTS_PER_WINDOW; i++) {
      const accepted = try_accept_connection("5.5.5.5", BASE_TIME);
      if (accepted) release_connection("5.5.5.5");
    }
    const after_window = BASE_TIME + CONNECTION_RATE_WINDOW_MS + 1;
    assert.equal(try_accept_connection("5.5.5.5", after_window), true);
  });

  test("attempts rejected by the concurrent cap still count toward the rate window", () => {
    const ip = "6.6.6.6";

    // Fill the concurrent cap.
    for (let i = 0; i < MAX_CONCURRENT_CONNECTIONS_PER_IP; i++) {
      assert.equal(try_accept_connection(ip, BASE_TIME), true);
    }

    // Every further call is rejected due to the concurrent cap, but each
    // one should still consume rate-window budget — otherwise an
    // attacker could probe indefinitely for free by staying at the cap.
    const remaining_budget =
      MAX_CONNECTION_ATTEMPTS_PER_WINDOW - MAX_CONCURRENT_CONNECTIONS_PER_IP;
    for (let i = 0; i < remaining_budget; i++) {
      assert.equal(try_accept_connection(ip, BASE_TIME), false);
    }

    // Release every connection so the concurrent cap is no longer a
    // factor — if the rate window was properly consumed above, the next
    // attempt should still be rejected purely on rate grounds.
    for (let i = 0; i < MAX_CONCURRENT_CONNECTIONS_PER_IP; i++) {
      release_connection(ip);
    }
    assert.equal(try_accept_connection(ip, BASE_TIME), false);
  });

  test("independent IPs have independent rate windows", () => {
    for (let i = 0; i < MAX_CONNECTION_ATTEMPTS_PER_WINDOW; i++) {
      const accepted = try_accept_connection("7.7.7.7", BASE_TIME);
      if (accepted) release_connection("7.7.7.7");
    }
    assert.equal(try_accept_connection("7.7.7.7", BASE_TIME), false);
    // A different IP should still have its full budget available.
    assert.equal(try_accept_connection("8.8.8.8", BASE_TIME), true);
  });
});

describe("release_connection", () => {
  test("decrements the active connection count", () => {
    try_accept_connection("1.2.3.4", BASE_TIME);
    try_accept_connection("1.2.3.4", BASE_TIME);
    assert.equal(get_active_connection_count("1.2.3.4"), 2);
    release_connection("1.2.3.4");
    assert.equal(get_active_connection_count("1.2.3.4"), 1);
  });

  test("never drops the count below zero", () => {
    release_connection("1.2.3.4");
    release_connection("1.2.3.4");
    assert.equal(get_active_connection_count("1.2.3.4"), 0);
  });

  test("is a harmless no-op for an IP with no tracked state", () => {
    assert.doesNotThrow(() => release_connection("9.9.9.9"));
  });
});

describe("get_active_connection_count", () => {
  test("returns 0 for an IP that has never connected", () => {
    assert.equal(get_active_connection_count("1.2.3.4"), 0);
  });

  test("reflects accepted connections not yet released", () => {
    try_accept_connection("1.2.3.4", BASE_TIME);
    try_accept_connection("1.2.3.4", BASE_TIME);
    try_accept_connection("1.2.3.4", BASE_TIME);
    assert.equal(get_active_connection_count("1.2.3.4"), 3);
  });
});

describe("extract_client_ip", () => {
  test("uses the X-Forwarded-For header when present", () => {
    assert.equal(extract_client_ip("203.0.113.5", undefined), "203.0.113.5");
  });

  test("takes the first address from a comma-separated forwarding chain", () => {
    assert.equal(
      extract_client_ip("203.0.113.5, 10.0.0.1, 10.0.0.2", undefined),
      "203.0.113.5",
    );
  });

  test("trims whitespace around the first address in a chain", () => {
    assert.equal(
      extract_client_ip("  203.0.113.5  ,10.0.0.1", undefined),
      "203.0.113.5",
    );
  });

  test("takes the first entry when the header arrives as an array", () => {
    assert.equal(
      extract_client_ip(["203.0.113.5", "198.51.100.9"], undefined),
      "203.0.113.5",
    );
  });

  test("falls back to the socket address when no header is present", () => {
    assert.equal(extract_client_ip(undefined, "127.0.0.1"), "127.0.0.1");
  });

  test("falls back to the socket address when the header is an empty string", () => {
    assert.equal(extract_client_ip("", "127.0.0.1"), "127.0.0.1");
  });

  test("returns 'unknown' when neither the header nor the socket address is available", () => {
    assert.equal(extract_client_ip(undefined, undefined), "unknown");
  });
});

describe("cleanup_stale_ip_state", () => {
  test("removes an IP with no active connections and only expired attempts", () => {
    try_accept_connection("1.2.3.4", BASE_TIME);
    release_connection("1.2.3.4");

    const after_window = BASE_TIME + CONNECTION_RATE_WINDOW_MS + 1;
    const removed_count = cleanup_stale_ip_state(after_window);

    assert.equal(removed_count, 1);
    assert.equal(get_active_connection_count("1.2.3.4"), 0);
  });

  test("keeps an IP with an active connection even if its attempts have expired", () => {
    try_accept_connection("1.2.3.4", BASE_TIME);
    // Deliberately not released — connection is still "open".

    const after_window = BASE_TIME + CONNECTION_RATE_WINDOW_MS + 1;
    const removed_count = cleanup_stale_ip_state(after_window);

    assert.equal(removed_count, 0);
    assert.equal(get_active_connection_count("1.2.3.4"), 1);
  });

  test("keeps an IP with recent attempts even if it has no active connections", () => {
    try_accept_connection("1.2.3.4", BASE_TIME);
    release_connection("1.2.3.4");

    const still_within_window = BASE_TIME + CONNECTION_RATE_WINDOW_MS - 1;
    const removed_count = cleanup_stale_ip_state(still_within_window);

    assert.equal(removed_count, 0);
  });

  test("returns 0 when there is nothing to clean up", () => {
    assert.equal(cleanup_stale_ip_state(BASE_TIME), 0);
  });
});

describe("start_rate_limit_cleanup / stop_rate_limit_cleanup", () => {
  test("can be started and stopped without throwing", () => {
    assert.doesNotThrow(() => {
      start_rate_limit_cleanup();
      stop_rate_limit_cleanup();
    });
  });

  test("calling start twice does not throw or misbehave", () => {
    assert.doesNotThrow(() => {
      start_rate_limit_cleanup();
      start_rate_limit_cleanup();
      stop_rate_limit_cleanup();
    });
  });

  test("stop is safe to call when never started", () => {
    assert.doesNotThrow(() => stop_rate_limit_cleanup());
  });
});
