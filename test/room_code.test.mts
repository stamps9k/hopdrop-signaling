import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generate_room_code, is_valid_room_code } from "../src/room_code.mjs";

describe("generate_room_code", () => {
  test("generates a code of the default length", () => {
    const code = generate_room_code();
    assert.equal(code.length, 6);
  });

  test("generates a code of a custom length", () => {
    const code = generate_room_code(10);
    assert.equal(code.length, 10);
  });

  test("throws on a non-positive length", () => {
    assert.throws(() => generate_room_code(0), RangeError);
    assert.throws(() => generate_room_code(-1), RangeError);
  });

  test("only uses characters from the allowed alphabet", () => {
    const allowed = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    const code = generate_room_code(50);
    for (const char of code) {
      assert.ok(allowed.includes(char), `unexpected character: ${char}`);
    }
  });

  test("never contains visually ambiguous characters", () => {
    const code = generate_room_code(200);
    for (const banned of ["0", "O", "1", "I", "L"]) {
      assert.ok(!code.includes(banned), `found banned character: ${banned}`);
    }
  });

  test("produces distinct codes across many calls (no obvious bias)", () => {
    const codes = new Set<string>();
    const sample_size = 10_000;
    for (let i = 0; i < sample_size; i++) {
      codes.add(generate_room_code());
    }
    // With ~30 bits of entropy at length 6, collisions in a 10k sample
    // should be rare; a low unique count would indicate a broken RNG.
    assert.ok(
      codes.size > sample_size * 0.99,
      `expected near-unique codes, got ${codes.size}/${sample_size}`,
    );
  });
});

describe("is_valid_room_code", () => {
  test("accepts a well-formed code", () => {
    const code = generate_room_code();
    assert.equal(is_valid_room_code(code), true);
  });

  test("rejects codes of the wrong length", () => {
    assert.equal(is_valid_room_code("ABC23"), false); // too short
    assert.equal(is_valid_room_code("ABC234567"), false); // too long
  });

  test("rejects codes containing disallowed characters", () => {
    assert.equal(is_valid_room_code("ABC0123"), false); // contains banned "0"
    assert.equal(is_valid_room_code("ABCO12"), false); // contains banned "O"
    assert.equal(is_valid_room_code("abc234"), false); // lowercase not in alphabet
  });

  test("respects a custom expected length", () => {
    const code = generate_room_code(10);
    assert.equal(is_valid_room_code(code, 10), true);
    assert.equal(is_valid_room_code(code, 6), false);
  });
});
