/**
 * Crawler core types (Phase B, slice B1).
 *
 * Everything here is pure data + interfaces. Network, DB and clock are
 * injected, so the core is testable with fixtures only.
 *
 * SECURITY MODEL: every byte fetched from a source is UNTRUSTED DATA. The
 * crawler never feeds it to an LLM and never follows instructions found in
 * it; fields are parsed deterministically, sanitized and length-capped, and
 * the result only ever becomes a `pending_review` submission that a human
 * admin must approve.
 */

export const CRAWLER_USER_AGENT =
  "SportuZdarBot/1.0 (+https://sportuzdar.sk/bot)";

export type CountryCode = "SK" | "CZ";

/** One normalized, sanitized candidate event produced by an adapter. */
export interface CandidateEvent {
  /** Wire contract discriminator (`packages/api/src/crawler.ts`). */
  kind: "event";
  /** Stable per-source key (event URL, iCal UID, ...); idempotency key. */
  externalKey: string;
  title: string;
  /** ISO 8601 instant (UTC). */
  startDate: string;
  endDate: string | null;
  city: string | null;
  countryCode: CountryCode | null;
  venueName: string | null;
  organizerName: string | null;
  /** https URL of the event page (or `<feed>#<uid>` for feed-only items). */
  eventUrl: string | null;
  registrationUrl: string | null;
  summary: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Engine-internal: an explicit non-SK/CZ country was present. Never emitted. */
  foreignCountry?: boolean;
}

/** Raw document an adapter asked the engine to fetch. */
export interface FetchedDocument {
  url: string;
  contentType: string;
  body: string;
}

export interface SourceContext {
  /** Polite, budgeted fetch (robots, rate limit, page cap already applied). */
  fetchDocument: (url: string) => Promise<FetchedDocument | null>;
}

/** A source adapter: how to get documents and turn them into candidates. */
export interface SourceAdapter {
  /** Fetch the listing/feed documents (bounded by the polite fetcher). */
  fetchList: (ctx: SourceContext) => Promise<FetchedDocument[]>;
  /** Parse one fetched document into candidates (pure, never throws). */
  parse: (doc: FetchedDocument) => CandidateEvent[];
}

/** Owner-approved source. Registry lives in `sources.ts` (empty in B1). */
export interface SourceConfig {
  /** Stable machine id, `[a-z0-9-]+`. */
  id: string;
  name: string;
  /** Hostnames (no scheme) this source may fetch from. */
  allowedHosts: string[];
  /** Politeness overrides; hard caps in `limits.ts` always win. */
  minDelayMs?: number;
  maxPages?: number;
  /** Fallback country when the document does not say. */
  defaultCountry?: CountryCode;
  adapter: SourceAdapter;
}

export type FetchOutcome =
  | {
      ok: true;
      status: number;
      body: string;
      contentType: string;
      finalUrl: string;
    }
  | { ok: false; error: string; status?: number; location?: string };

/** Network port. Production impl wraps the SSRF-safe `safeFetchText`. */
export type Fetcher = (
  url: string,
  options: { accept: string; maxBytes?: number },
) => Promise<FetchOutcome>;

export interface SourceReport {
  sourceId: string;
  pagesFetched: number;
  candidatesParsed: number;
  rejected: number;
  /** Dropped by in-run dedup (same key or near-identical title+date). */
  duplicates: number;
  /** Candidates emitted for the receiver. */
  emitted: number;
  errors: string[];
  stoppedBecause:
    "done" | "page-cap" | "run-cap" | "candidate-cap" | "robots" | "error";
}

export interface SourceResult {
  report: SourceReport;
  candidates: CandidateEvent[];
}

export interface CrawlResult {
  startedAt: string;
  sources: SourceResult[];
}
