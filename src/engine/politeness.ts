/**
 * Polite, budgeted fetching: robots.txt per origin, one fixed user agent,
 * per-host rate limit, page budget, host allowlist.
 *
 * Redirects are handled HERE, one hop at a time (the fetcher never follows
 * them): every hop re-runs the allowlist, robots, throttle and budget checks,
 * so a redirect can never reach an unapproved host or a disallowed path.
 * Robots state and throttle clocks are shared across sources in one run.
 * Network and time are injected.
 */

import { CRAWLER_LIMITS } from "./limits.js";
import {
  isPathAllowed,
  parseRobots,
  robotsFromStatus,
  ROBOTS_BLOCK_ALL,
  type RobotsRules,
} from "./robots.js";
import type { Fetcher, FetchedDocument } from "./types.js";

export interface PoliteShared {
  robotsByOrigin: Map<string, RobotsRules>;
  lastRequestAt: Map<string, number>;
}

export function createPoliteShared(): PoliteShared {
  return { robotsByOrigin: new Map(), lastRequestAt: new Map() };
}

export interface PoliteOptions {
  fetcher: Fetcher;
  allowedHosts: string[];
  minDelayMs: number;
  maxPages: number;
  /** Shared across sources so the per-run cap holds. */
  runBudget: { remaining: number };
  shared?: PoliteShared;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type PoliteStop = "done" | "page-cap" | "run-cap" | "robots" | "error";

export interface PoliteFetcher {
  fetchDocument: (url: string) => Promise<FetchedDocument | null>;
  stats: () => { pages: number; stopped: PoliteStop; errors: string[] };
}

const ACCEPT =
  "text/html,application/xhtml+xml,text/calendar,application/json;q=0.8,*/*;q=0.5";
const MAX_HOPS = 3;
/** A source asking for a longer Crawl-delay is skipped, not hammered. */
const MAX_CRAWL_DELAY_SEC = 30;

export function createPoliteFetcher(opts: PoliteOptions): PoliteFetcher {
  const hosts = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  const shared = opts.shared ?? createPoliteShared();
  const delayMs = Math.max(opts.minDelayMs, CRAWLER_LIMITS.minDelayMs);
  const pageCap = Math.min(opts.maxPages, CRAWLER_LIMITS.maxPagesPerSource);
  let pages = 0;
  let stopped: PoliteStop = "done";
  const errors: string[] = [];

  async function throttle(host: string, extraMs = 0) {
    const wait = Math.max(delayMs, extraMs);
    // Reserve the slot synchronously (before any await) so concurrent callers
    // on one host are serialized instead of all sleeping the same interval.
    const t = opts.now();
    const last = shared.lastRequestAt.get(host);
    const start = last === undefined ? t : Math.max(t, last + wait);
    shared.lastRequestAt.set(host, start);
    if (start > t) await opts.sleep(start - t);
  }

  function allowed(url: URL): boolean {
    return url.protocol === "https:" && hosts.has(url.hostname.toLowerCase());
  }

  async function robotsFor(origin: URL): Promise<RobotsRules> {
    const cached = shared.robotsByOrigin.get(origin.origin);
    if (cached) return cached;
    let target = new URL(`${origin.origin}/robots.txt`);
    let rules: RobotsRules = ROBOTS_BLOCK_ALL;
    for (let hop = 0; hop <= 2; hop++) {
      await throttle(target.host);
      const res = await opts.fetcher(target.toString(), {
        accept: "text/plain",
        maxBytes: 128 * 1024,
      });
      if (res.ok) {
        rules = parseRobots(res.body);
        break;
      }
      if (res.error === "redirect" && res.location) {
        // Only same-origin redirects are trusted for robots.txt.
        try {
          const next = new URL(res.location, target);
          if (next.origin !== origin.origin) break;
          target = next;
          continue;
        } catch {
          break;
        }
      }
      rules = robotsFromStatus(res.status);
      break;
    }
    shared.robotsByOrigin.set(origin.origin, rules);
    return rules;
  }

  async function fetchDocument(input: string): Promise<FetchedDocument | null> {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      errors.push("invalid-url");
      return null;
    }

    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (!allowed(url)) {
        errors.push(`host-not-allowed:${url.hostname}`);
        return null;
      }
      // Reserve budget synchronously, before any await (no concurrent overrun).
      if (pages >= pageCap) {
        stopped = "page-cap";
        return null;
      }
      if (opts.runBudget.remaining <= 0) {
        stopped = "run-cap";
        return null;
      }
      pages++;
      opts.runBudget.remaining--;

      const rules = await robotsFor(url);
      if (!isPathAllowed(rules, `${url.pathname}${url.search}`)) {
        stopped = "robots";
        errors.push(`robots-disallow:${url.pathname}`);
        return null;
      }
      if (
        rules.crawlDelaySec !== null &&
        rules.crawlDelaySec > MAX_CRAWL_DELAY_SEC
      ) {
        stopped = "robots";
        errors.push("crawl-delay-too-long");
        return null;
      }
      await throttle(url.host, (rules.crawlDelaySec ?? 0) * 1000);

      const res = await opts.fetcher(url.toString(), {
        accept: ACCEPT,
        maxBytes: CRAWLER_LIMITS.maxBodyBytes,
      });
      if (res.ok) {
        return {
          url: url.toString(),
          contentType: res.contentType,
          body: res.body,
        };
      }
      if (res.error === "redirect" && res.location) {
        try {
          url = new URL(res.location, url);
          continue;
        } catch {
          errors.push("bad-redirect");
          return null;
        }
      }
      errors.push(`fetch:${res.error}${res.status ? `:${res.status}` : ""}`);
      if (stopped === "done") stopped = "error";
      return null;
    }
    errors.push("too-many-redirects");
    return null;
  }

  return {
    fetchDocument,
    stats: () => ({ pages, stopped, errors: [...errors] }),
  };
}
