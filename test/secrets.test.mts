import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load_secret_from_file } from "../src/secrets.mjs";

const TEST_ENV_VAR = "TEST_SECRET_FILE";

describe("load_secret_from_file", () => {
  let temp_dir: string;

  beforeEach(() => {
    temp_dir = mkdtempSync(join(tmpdir(), "hopdrop-secrets-test-"));
  });

  afterEach(() => {
    delete process.env[TEST_ENV_VAR];
    rmSync(temp_dir, { recursive: true, force: true });
  });

  test("reads and trims secret from file path in env var", () => {
    const secret_path = join(temp_dir, "secret.txt");
    writeFileSync(secret_path, "super-secret-value\n");
    process.env[TEST_ENV_VAR] = secret_path;

    const result = load_secret_from_file(TEST_ENV_VAR);

    assert.equal(result, "super-secret-value");
  });

  test("trims surrounding whitespace and newlines", () => {
    const secret_path = join(temp_dir, "secret.txt");
    writeFileSync(secret_path, "  value-with-whitespace  \n\n");
    process.env[TEST_ENV_VAR] = secret_path;

    const result = load_secret_from_file(TEST_ENV_VAR);

    assert.equal(result, "value-with-whitespace");
  });

  test("throws when env var is not set", () => {
    delete process.env[TEST_ENV_VAR];

    assert.throws(
      () => load_secret_from_file(TEST_ENV_VAR),
      /TEST_SECRET_FILE is required/,
    );
  });

  test("throws when env var is empty string", () => {
    process.env[TEST_ENV_VAR] = "";

    assert.throws(
      () => load_secret_from_file(TEST_ENV_VAR),
      /TEST_SECRET_FILE is required/,
    );
  });

  test("throws when file does not exist at given path", () => {
    process.env[TEST_ENV_VAR] = join(temp_dir, "does-not-exist.txt");

    assert.throws(() => load_secret_from_file(TEST_ENV_VAR));
  });
});
