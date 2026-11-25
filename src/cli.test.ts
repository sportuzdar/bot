import assert from "node:assert/strict";
import test from "node:test";
import { allowedIngestHosts, parseRunOptions, sendBatch } from "./cli.js";

const batch = {
  schemaVersion: 1 as const,
  source: { id: "example", name: "Example" },
  fetchedAt: "2026-11-25T12:00:00.000Z",
  candidates: [],
};

test("sendBatch retries network and 5xx failures at most twice", async () => {
  let attempts = 0;
  const fakeFetch: typeof fetch = async () => {
    attempts++;
    if (attempts === 1) throw new Error("offline");
    if (attempts === 2) return new Response("", { status: 503 });
    return new Response(
      JSON.stringify({
        schemaVersion: 1,
        sourceId: "example",
        counts: { received: 0, created: 0, duplicate: 0, rejected: 0 },
        results: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  assert.equal(
    (
      await sendBatch(batch, {
        url: "https://sportuzdar.sk/api/internal/crawler/ingest",
        token: "secret",
        fetch: fakeFetch,
        sleep: async () => {},
      })
    ).ok,
    true,
  );
  assert.equal(attempts, 3);
});

test("sendBatch stops immediately on receiver validation errors", async () => {
  let attempts = 0;
  const fakeFetch: typeof fetch = async () => {
    attempts++;
    return new Response("invalid", { status: 422 });
  };
  const result = await sendBatch(batch, {
    url: "https://sportuzdar.sk/api/internal/crawler/ingest",
    token: "secret",
    fetch: fakeFetch,
    sleep: async () => {},
  });
  assert.deepEqual(result, { ok: false, status: 422, stopSource: true });
  assert.equal(attempts, 1);
});

test("sendBatch refuses non-HTTPS ingest endpoints without a request", async () => {
  let called = false;
  const fakeFetch: typeof fetch = async () => {
    called = true;
    return new Response("", { status: 200 });
  };
  const result = await sendBatch(batch, {
    url: "http://example.org/ingest",
    token: "secret",
    fetch: fakeFetch,
  });
  assert.deepEqual(result, { ok: false, stopSource: true });
  assert.equal(called, false);
});

function failingFetch(): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  return {
    fetch: async () => {
      calls++;
      throw new Error("must not be called");
    },
    calls: () => calls,
  };
}

test("sendBatch never sends the token to a host outside the allowlist", async () => {
  for (const url of [
    "https://attacker.example/ingest",
    "https://sportuzdar.sk.attacker.example/ingest",
    "https://user:pass@sportuzdar.sk/ingest",
    "https://sportuzdar.sk:8443/ingest",
  ]) {
    const spy = failingFetch();
    const result = await sendBatch(batch, {
      url,
      token: "secret",
      fetch: spy.fetch,
      sleep: async () => {},
    });
    assert.deepEqual(result, { ok: false, stopSource: true }, url);
    assert.equal(spy.calls(), 0, url);
  }
});

test("sendBatch accepts extra hosts only when explicitly allowed", async () => {
  const spy = failingFetch();
  const refused = await sendBatch(batch, {
    url: "https://preview.example/ingest",
    token: "secret",
    fetch: spy.fetch,
    sleep: async () => {},
  });
  assert.equal(refused.ok, false);
  assert.equal(spy.calls(), 0);
  assert.ok(allowedIngestHosts(" Preview.Example , ").has("preview.example"));
});

test("sendBatch forbids redirects so the token cannot follow them", async () => {
  let redirectMode: RequestRedirect | undefined;
  const fakeFetch: typeof fetch = async (_url, init) => {
    redirectMode = init?.redirect;
    return new Response("", { status: 401 });
  };
  const result = await sendBatch(batch, {
    url: "https://sportuzdar.sk/api/internal/crawler/ingest",
    token: "secret",
    fetch: fakeFetch,
    sleep: async () => {},
  });
  assert.equal(redirectMode, "error");
  assert.deepEqual(result, { ok: false, status: 401, stopSource: true });
});

test("parseRunOptions rejects missing flag values and unknown flags", () => {
  assert.throws(
    () => parseRunOptions(["--source"]),
    /Missing value for --source/,
  );
  assert.throws(
    () => parseRunOptions(["--source", "--dry-run"]),
    /Missing value for --source/,
  );
  assert.throws(() => parseRunOptions(["--out"]), /Missing value for --out/);
  assert.throws(() => parseRunOptions(["--sorce", "x"]), /Unknown option/);
  assert.deepEqual(
    parseRunOptions(["--dry-run", "--source", "a", "--out", "b.json"]),
    {
      dryRun: true,
      sourceId: "a",
      out: "b.json",
    },
  );
});
