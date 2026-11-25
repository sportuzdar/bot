/**
 * Engine orchestration: sources → polite fetch → parse → validate → in-run
 * dedup → candidates. Pure over injected ports (fetcher, sleep, clock); no
 * database, no framework. The caller (bot) sends the candidates to the
 * receiver, which does the cross-run dedup and persistence.
 */

import { isSimilarTitleAndDate } from "./dedup.js";
import { CRAWLER_LIMITS } from "./limits.js";
import { validateCandidate } from "./normalize.js";
import {
  createPoliteFetcher,
  createPoliteShared,
  type PoliteShared,
} from "./politeness.js";
import type {
  CandidateEvent,
  CrawlResult,
  Fetcher,
  SourceConfig,
  SourceResult,
} from "./types.js";

export interface RunDeps {
  fetcher: Fetcher;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export async function runCrawl(
  sources: SourceConfig[],
  deps: RunDeps,
): Promise<CrawlResult> {
  const startedAt = new Date(deps.now()).toISOString();
  const runBudget = { remaining: CRAWLER_LIMITS.maxPagesPerRun };
  const shared = createPoliteShared();
  const results: SourceResult[] = [];
  for (const source of sources) {
    results.push(await crawlSource(source, deps, runBudget, shared));
  }
  return { startedAt, sources: results };
}

async function crawlSource(
  source: SourceConfig,
  deps: RunDeps,
  runBudget: { remaining: number },
  shared: PoliteShared,
): Promise<SourceResult> {
  const polite = createPoliteFetcher({
    fetcher: deps.fetcher,
    allowedHosts: source.allowedHosts,
    minDelayMs: source.minDelayMs ?? CRAWLER_LIMITS.minDelayMs,
    maxPages: source.maxPages ?? CRAWLER_LIMITS.maxPagesPerSource,
    runBudget,
    shared,
    sleep: deps.sleep,
    now: deps.now,
  });
  const report: SourceResult["report"] = {
    sourceId: source.id,
    pagesFetched: 0,
    candidatesParsed: 0,
    rejected: 0,
    duplicates: 0,
    emitted: 0,
    errors: [],
    stoppedBecause: "done",
  };
  const candidates: CandidateEvent[] = [];

  try {
    const docs = await source.adapter.fetchList({
      fetchDocument: polite.fetchDocument,
    });
    const keys = new Set<string>();
    const now = new Date(deps.now());

    outer: for (const doc of docs) {
      let parsed: CandidateEvent[] = [];
      try {
        parsed = source.adapter.parse(doc);
      } catch {
        report.errors.push("parse-failed");
        continue;
      }
      for (const raw of parsed) {
        report.candidatesParsed++;
        const { foreignCountry, ...rest } = raw;
        if (foreignCountry) {
          // Explicitly outside SK/CZ: never relabel with the default country.
          report.rejected++;
          continue;
        }
        const candidate: CandidateEvent = {
          ...rest,
          countryCode: rest.countryCode ?? source.defaultCountry ?? null,
          endDate:
            rest.endDate &&
            Date.parse(rest.endDate) >= Date.parse(rest.startDate)
              ? rest.endDate
              : null,
        };
        if (!validateCandidate(candidate, now).ok) {
          report.rejected++;
          continue;
        }
        if (
          keys.has(candidate.externalKey) ||
          candidates.some((c) => isSimilarTitleAndDate(c, candidate))
        ) {
          report.duplicates++;
          continue;
        }
        if (candidates.length >= CRAWLER_LIMITS.maxCandidatesPerSource) {
          report.stoppedBecause = "candidate-cap";
          break outer;
        }
        keys.add(candidate.externalKey);
        candidates.push(candidate);
      }
    }
  } catch (e) {
    report.errors.push(
      `source-failed:${e instanceof Error ? e.name : "error"}`,
    );
    report.stoppedBecause = "error";
  }

  const stats = polite.stats();
  report.pagesFetched = stats.pages;
  report.emitted = candidates.length;
  report.errors.push(...stats.errors);
  if (report.stoppedBecause === "done") report.stoppedBecause = stats.stopped;
  return { report, candidates };
}
