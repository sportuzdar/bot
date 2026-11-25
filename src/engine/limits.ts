/** Hard caps. Per-source config may only tighten (never loosen) these. */
export const CRAWLER_LIMITS = {
  /** Minimum delay between two requests to the same host. */
  minDelayMs: 2_000,
  /** Pages (documents, excluding robots.txt) per source per run. */
  maxPagesPerSource: 20,
  /** Pages across all sources per run. */
  maxPagesPerRun: 60,
  /** Candidates emitted per source per run (review queue protection). */
  maxCandidatesPerSource: 100,
  /** Response body cap per document. */
  maxBodyBytes: 512 * 1024,
  /** Candidates parsed from a single document. */
  maxCandidatesPerDocument: 200,
  /** Events further than this in the future are rejected as implausible. */
  maxFutureDays: 800,
  /** Field length caps (sanitize). */
  maxTitleChars: 200,
  maxSummaryChars: 600,
  maxShortChars: 120,
  maxUrlChars: 500,
} as const;
