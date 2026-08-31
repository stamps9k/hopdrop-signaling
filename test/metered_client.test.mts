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
  const fake_ice_servers = [
    {
      urls: "turn:standard.relay.metered.ca:80",
      username: "user1",
      credential: "pass1",
    },
  ];

  afterEach(() => {
    globalThis.fetch = original_fetch;
  });

  test("returns parsed JSON on success", async () => {
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
      return new Response(JSON.stringify(fake_ice_servers), { status: 200 });
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

  test("sets reason: bad_status and the actual status on a non-ok response", async () => {
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
      assert.equal(error.reason, "bad_status");
      assert.equal(error.status, 500);
    }
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

  test("sets reason: network_error and no status on a network failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;

    try {
      await fetch_metered_ice_servers(fake_credentials_url, fake_api_key);
      assert.fail("expected fetch_metered_ice_servers to throw");
    } catch (error) {
      if (!(error instanceof TurnCredentialFetchError)) {
        assert.fail("expected TurnCredentialFetchError");
        return;
      }
      assert.equal(error.reason, "network_error");
      assert.equal(error.status, undefined);
    }
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

  test("sets reason: invalid_json when the response body is not valid JSON", async () => {
    globalThis.fetch = (async () =>
      new Response("not json", { status: 200 })) as typeof fetch;

    try {
      await fetch_metered_ice_servers(fake_credentials_url, fake_api_key);
      assert.fail("expected fetch_metered_ice_servers to throw");
    } catch (error) {
      if (!(error instanceof TurnCredentialFetchError)) {
        assert.fail("expected TurnCredentialFetchError");
        return;
      }
      assert.equal(error.reason, "invalid_json");
    }
  });

  describe("response shape validation", () => {
    test("rejects a response that is a single credential object rather than an array - the exact create-vs-get endpoint mix-up hit during setup", async () => {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            username: "834b8a8f627583cf7fa21867",
            password: "Epg/fgRmQoB0jDsf",
            label: "created-via-api",
            apiKey: "d76fd382e931249924d3bc3fff70f728cdb7",
          }),
          { status: 200 },
        )) as typeof fetch;

      try {
        await fetch_metered_ice_servers(fake_credentials_url, fake_api_key);
        assert.fail("expected fetch_metered_ice_servers to throw");
      } catch (error) {
        if (!(error instanceof TurnCredentialFetchError)) {
          assert.fail("expected TurnCredentialFetchError");
          return;
        }
        assert.equal(error.reason, "invalid_shape");
      }
    });

    test("rejects an empty array", async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify([]), { status: 200 })) as typeof fetch;

      await assert.rejects(
        () => fetch_metered_ice_servers(fake_credentials_url, fake_api_key),
        TurnCredentialFetchError,
      );
    });

    test("rejects an array entry missing urls", async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify([{ username: "u", credential: "p" }]), {
          status: 200,
        })) as typeof fetch;

      await assert.rejects(
        () => fetch_metered_ice_servers(fake_credentials_url, fake_api_key),
        TurnCredentialFetchError,
      );
    });

    test("rejects an array entry whose urls is neither a string nor an array", async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify([{ urls: 123 }]), {
          status: 200,
        })) as typeof fetch;

      await assert.rejects(
        () => fetch_metered_ice_servers(fake_credentials_url, fake_api_key),
        TurnCredentialFetchError,
      );
    });

    test("rejects an array entry with an invalid credentialType", async () => {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify([
            {
              urls: "turn:example.com",
              username: "u",
              credential: "p",
              credentialType: "token",
            },
          ]),
          { status: 200 },
        )) as typeof fetch;

      await assert.rejects(
        () => fetch_metered_ice_servers(fake_credentials_url, fake_api_key),
        TurnCredentialFetchError,
      );
    });

    test("accepts an entry with urls as an array of strings and no username/credential", async () => {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify([
            { urls: ["stun:a.example.com", "stun:b.example.com"] },
          ]),
          { status: 200 },
        )) as typeof fetch;

      const result = await fetch_metered_ice_servers(
        fake_credentials_url,
        fake_api_key,
      );
      assert.equal(result.length, 1);
    });
  });
});
