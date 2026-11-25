/**
 * Wire format sent to the receiver (`POST /api/internal/crawler/ingest`).
 * Mirrors `packages/api/src/crawler.ts` (schemaVersion 1); the engine keeps
 * its own copy of the type and never imports from the web monorepo.
 */

import type { CandidateEvent } from "./types.js";

export const INGEST_SCHEMA_VERSION = 1 as const;
/** Receiver hard limit per request. */
export const MAX_CANDIDATES_PER_REQUEST = 200;

export interface IngestBatch {
  schemaVersion: typeof INGEST_SCHEMA_VERSION;
  source: { id: string; name: string };
  fetchedAt: string;
  candidates: CandidateEvent[];
}

export function buildBatches(
  source: { id: string; name: string },
  candidates: CandidateEvent[],
  fetchedAt: string,
  size = MAX_CANDIDATES_PER_REQUEST,
): IngestBatch[] {
  const step = Math.max(1, Math.min(size, MAX_CANDIDATES_PER_REQUEST));
  const out: IngestBatch[] = [];
  for (let i = 0; i < candidates.length; i += step) {
    out.push({
      schemaVersion: INGEST_SCHEMA_VERSION,
      source,
      fetchedAt,
      candidates: candidates.slice(i, i + step),
    });
  }
  return out;
}
