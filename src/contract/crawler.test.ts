import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildBatches } from "../engine/batch.js";
import { crawlerIngestRequestSchema } from "./crawler.js";

test("golden ingest request satisfies schema version 1", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/ingest-request.v1.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(crawlerIngestRequestSchema.parse(fixture).schemaVersion, 1);
});

test("buildBatches emits receiver-valid requests", () => {
  const [batch] = buildBatches(
    { id: "example", name: "Example" },
    [
      {
        kind: "event",
        externalKey: "event-1",
        title: "Example Run",
        startDate: "2027-05-15T08:00:00.000Z",
        endDate: null,
        city: "Bratislava",
        countryCode: "SK",
        venueName: null,
        organizerName: "Example Club",
        eventUrl: "https://example.org/events/1",
        registrationUrl: null,
        summary: null,
        latitude: null,
        longitude: null,
      },
    ],
    "2026-11-25T12:00:00.000Z",
  );
  assert.ok(crawlerIngestRequestSchema.safeParse(batch).success);
});

test("unknown schema versions are rejected", () => {
  assert.equal(
    crawlerIngestRequestSchema.safeParse({ schemaVersion: 2 }).success,
    false,
  );
});
