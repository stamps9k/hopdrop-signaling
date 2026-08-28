import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  fetch_metered_ice_servers,
  TurnCredentialFetchError,
} from "../src/metered_client.mjs";

describe("fetch_metered_ice_servers", () => {
  const original_fetch = globalThis.fetch;
  const fake_credentials_url =
    "https://example.metered.live/api/v1/turn/credentials";
  const fake_api_key = "test-api-key-12345";

  afterEach(() => {
    globalThis.fetch = original_fetch;
  });

  test("returns parsed JSON on success", async () => {
    const fake_ice_servers = [
      {
        urls: "turn:standard.relay.metered.ca:80",
        username: "user1",
        credential: "pass1",
      },
    ];
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(fake_ice_servers), {
        status: 200,
      })) as typeof fetch;

    const result = await fetch_metered_ice_servers(
      fake_credentials_url,
      fake_api_key,
    );

    assert.deepEqual(result, fake_ice_servers);
  });

  test("includes the api key in the request URL", async () => {
    let captured_url: string | undefined;
    globalThis.fetch = (async (url: string) => {
      captured_url = url;
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;

    await fetch_metered_ice_servers(fake_credentials_url, fake_api_key);

    assert.ok(captured_url?.includes(encodeURIComponent(fake_api_key)));
  });

  test("throws TurnCredentialFetchError on non-ok response", async () => {
    globalThis.fetch = (async () =>
      new Response("Internal Server Error", { status: 500 })) as typeof fetch;

    await assert.rejects(
      () => fetch_metered_ice_servers(fake_credentials_url, fake_api_key),
      TurnCredentialFetchError,
    );
  });

  test("does not leak the api key in the error on non-ok response", async () => {
    globalThis.fetch = (async () =>
      new Response("Internal Server Error", { status: 500 })) as typeof fetch;

    try {
      await fetch_metered_ice_servers(fake_credentials_url, fake_api_key);
      assert.fail("expected fetch_metered_ice_servers to throw");
    } catch (error) {
      if (!(error instanceof TurnCredentialFetchError)) {
        assert.fail("expected TurnCredentialFetchError");
        return;
      }
      assert.equal(error.message.includes(fake_api_key), false);
      assert.equal(error.message.includes("apiKey"), false);
      assert.equal(error.status, 500);
    }
  });

  test("throws TurnCredentialFetchError on network failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error(
        `fetch failed: connection refused to ${fake_credentials_url}?apiKey=${fake_api_key}`,
      );
    }) as typeof fetch;

    await assert.rejects(
      () => fetch_metered_ice_servers(fake_credentials_url, fake_api_key),
      TurnCredentialFetchError,
    );
  });

  test("does not leak the api key in the error on network failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error(
        `fetch failed: connection refused to ${fake_credentials_url}?apiKey=${fake_api_key}`,
      );
    }) as typeof fetch;

    try {
      await fetch_metered_ice_servers(fake_credentials_url, fake_api_key);
      assert.fail("expected fetch_metered_ice_servers to throw");
    } catch (error) {
      if (!(error instanceof TurnCredentialFetchError)) {
        assert.fail("expected TurnCredentialFetchError");
        return;
      }
      assert.equal(error.message.includes(fake_api_key), false);
      assert.equal(error.status, undefined);
    }
  });

  test("throws TurnCredentialFetchError when response body is not valid JSON", async () => {
    globalThis.fetch = (async () =>
      new Response("not json", { status: 200 })) as typeof fetch;

    await assert.rejects(
      () => fetch_metered_ice_servers(fake_credentials_url, fake_api_key),
      TurnCredentialFetchError,
    );
  });
});
