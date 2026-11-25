import assert from "node:assert/strict";
import test from "node:test";
import { isSourceEligible, sourceDefinitionSchema } from "./sources.js";

const approved = {
  id: "example",
  name: "Example",
  country: "SK",
  tier: "green",
  adapter: "ical",
  startUrls: ["https://example.org/events.ics"],
  allowedHosts: ["example.org"],
  maxPages: 5,
  minDelayMs: 2000,
  termsUrl: "https://example.org/terms",
  termsCheckedAt: "2026-11-01",
  robotsCheckedAt: "2026-11-01",
  approvedBy: "owner",
  approvedAt: "2026-11-02T12:00:00Z",
  enabled: true,
  notes: "Synthetic",
} as const;

test("only enabled, approved green sources are eligible", () => {
  assert.equal(isSourceEligible(sourceDefinitionSchema.parse(approved)), true);
  assert.equal(
    isSourceEligible(
      sourceDefinitionSchema.parse({ ...approved, enabled: false }),
    ),
    false,
  );
  assert.equal(
    isSourceEligible(
      sourceDefinitionSchema.parse({ ...approved, approvedBy: null }),
    ),
    false,
  );
  assert.equal(
    isSourceEligible(
      sourceDefinitionSchema.parse({ ...approved, approvedAt: null }),
    ),
    false,
  );
  assert.equal(
    isSourceEligible(
      sourceDefinitionSchema.parse({ ...approved, tier: "amber" }),
    ),
    false,
  );
});

test("enabled defaults to false", () => {
  const { enabled: _, ...withoutEnabled } = approved;
  assert.equal(sourceDefinitionSchema.parse(withoutEnabled).enabled, false);
});
