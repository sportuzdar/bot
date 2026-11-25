/**
 * Candidate validation + shared normalization helpers used by adapters.
 */

import { datetimeLocalToUtc } from "./datetime.js";
import { CRAWLER_LIMITS } from "./limits.js";
import type { CandidateEvent, CountryCode } from "./types.js";

const DAY_MS = 86_400_000;

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Strict ISO 8601 → UTC ISO instant, or null (never throws, never rolls
 * impossible dates forward, never uses the server's local timezone).
 * - `YYYY-MM-DD` → noon UTC (no off-by-one in either SK/CZ timezone);
 * - with `Z`/offset → exact instant;
 * - without offset → Europe/Bratislava wall time.
 */
export function toIsoInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      value.trim(),
    );
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!validYmd(y, mo, d)) return null;
  if (m[4] === undefined)
    return new Date(Date.UTC(y, mo - 1, d, 12)).toISOString();
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? "0")];
  if (h > 23 || mi > 59 || s > 59) return null;
  if (m[7] === undefined) {
    const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
    const out = datetimeLocalToUtc(local);
    const t = Date.parse(out);
    if (!Number.isFinite(t)) return null;
    // datetimeLocalToUtc falls back to "as UTC" for nonexistent DST wall
    // times; a valid result is always exactly 1 h (CET) or 2 h (CEST) earlier.
    const diffH = (Date.UTC(y, mo - 1, d, h, mi) - t) / 3_600_000;
    if (diffH !== 1 && diffH !== 2) return null;
    return new Date(t + s * 1000).toISOString();
  }
  const off =
    m[7] === "Z"
      ? "Z"
      : m[7].length === 5
        ? `${m[7].slice(0, 3)}:${m[7].slice(3)}`
        : m[7];
  const t = Date.parse(
    `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${String(s).padStart(2, "0")}${off}`,
  );
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function normalizeCountry(value: unknown): CountryCode | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  if (
    ["sk", "svk", "slovakia", "slovensko", "slovenska republika"].includes(v)
  ) {
    return "SK";
  }
  if (
    [
      "cz",
      "cze",
      "czechia",
      "czech republic",
      "cesko",
      "ceska republika",
    ].includes(v)
  ) {
    return "CZ";
  }
  return null;
}

/** True when a non-empty country value is present but is not SK/CZ. */
export function isForeignCountry(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    normalizeCountry(value) === null
  );
}

export type RejectReason =
  | "missing-title"
  | "missing-start"
  | "in-the-past"
  | "too-far-future"
  | "missing-country"
  | "missing-url";

/**
 * Gatekeeper: a candidate must have a title, a plausible future start, a
 * SK/CZ country and an https URL — the minimum `submitForReview` requires.
 */
export function validateCandidate(
  c: CandidateEvent,
  now: Date,
): { ok: true } | { ok: false; reason: RejectReason } {
  if (!c.title) return { ok: false, reason: "missing-title" };
  const start = Date.parse(c.startDate);
  if (!Number.isFinite(start)) return { ok: false, reason: "missing-start" };
  if (start < now.getTime() - DAY_MS)
    return { ok: false, reason: "in-the-past" };
  if (start > now.getTime() + CRAWLER_LIMITS.maxFutureDays * DAY_MS) {
    return { ok: false, reason: "too-far-future" };
  }
  if (!c.countryCode) return { ok: false, reason: "missing-country" };
  if (!c.eventUrl) return { ok: false, reason: "missing-url" };
  return { ok: true };
}
