/**
 * Minimal robots.txt parser/matcher (RFC 9309 subset).
 *
 * - Group selection: the most specific `User-agent` token that matches our
 *   product token ("sportuzdarbot"); otherwise `*`.
 * - Longest-match wins, `Allow` beats `Disallow` on equal length.
 * - `*` wildcard and `$` end anchor supported.
 * - HTTP semantics (applied by the caller via `robotsFromStatus`):
 *   4xx → allow all, 5xx / unreachable → disallow all (fail closed).
 */

export interface RobotsRules {
  allows: string[];
  disallows: string[];
  /** Seconds, if the matching group declares `Crawl-delay`. */
  crawlDelaySec: number | null;
  /** True for the fail-closed "disallow everything" policy. */
  blockAll: boolean;
}

export const ROBOTS_ALLOW_ALL: RobotsRules = {
  allows: [],
  disallows: [],
  crawlDelaySec: null,
  blockAll: false,
};

export const ROBOTS_BLOCK_ALL: RobotsRules = {
  allows: [],
  disallows: [],
  crawlDelaySec: null,
  blockAll: true,
};

const PRODUCT_TOKEN = "sportuzdarbot";

export function robotsFromStatus(status: number | undefined): RobotsRules {
  // 429/408 mean "slow down / try later", not "no rules": fail closed.
  if (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 429 &&
    status !== 408
  ) {
    return ROBOTS_ALLOW_ALL;
  }
  return ROBOTS_BLOCK_ALL;
}

export function parseRobots(text: string): RobotsRules {
  const groups: Array<{
    agents: string[];
    allows: string[];
    disallows: string[];
    delay: number | null;
  }> = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], allows: [], disallows: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (value.length > 500) continue;
    if (field === "allow" && value) current.allows.push(value);
    else if (field === "disallow" && value) current.disallows.push(value);
    else if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = n;
    }
  }

  const specific = groups.filter((g) =>
    g.agents.some((a) => a === PRODUCT_TOKEN || a === "sportuzdar"),
  );
  const chosen = specific.length
    ? specific
    : groups.filter((g) => g.agents.includes("*"));
  if (chosen.length === 0) return ROBOTS_ALLOW_ALL;

  return {
    allows: chosen.flatMap((g) => g.allows),
    disallows: chosen.flatMap((g) => g.disallows),
    crawlDelaySec: chosen.reduce<number | null>(
      (acc, g) => (g.delay === null ? acc : Math.max(acc ?? 0, g.delay)),
      null,
    ),
    blockAll: false,
  };
}

/**
 * Linear-time robots pattern match (`*` wildcard, trailing `$` anchor).
 * No regex compilation, so hostile patterns cannot cause backtracking.
 */
function matchLength(pattern: string, path: string): number {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split("*");
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i === 0) {
      if (!path.startsWith(part)) return -1;
      pos = part.length;
      continue;
    }
    if (i === parts.length - 1 && anchored) {
      if (path.length - pos < part.length) return -1;
      return path.endsWith(part) ? pattern.length : -1;
    }
    const idx = path.indexOf(part, pos);
    if (idx < 0) return -1;
    pos = idx + part.length;
  }
  if (anchored && parts.length === 1)
    return path === body ? pattern.length : -1;
  return pattern.length;
}

/** `path` must include the query string (`/a?b=1`). */
export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  if (rules.blockAll) return false;
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const p of rules.allows)
    bestAllow = Math.max(bestAllow, matchLength(p, path));
  for (const p of rules.disallows) {
    bestDisallow = Math.max(bestDisallow, matchLength(p, path));
  }
  if (bestDisallow < 0) return true;
  return bestAllow >= bestDisallow;
}
