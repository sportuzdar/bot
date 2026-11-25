/**
 * schema.org Event extraction from JSON-LD (`<script type="application/ld+json">`).
 *
 * Pure + defensive: any malformed block is skipped, never thrown. Only
 * `Event` and its sport-relevant subtypes are accepted; `@graph`, arrays and
 * `ItemList` wrappers are unwrapped.
 */

import { CRAWLER_LIMITS } from "./limits.js";
import {
  isForeignCountry,
  normalizeCountry,
  toIsoInstant,
} from "./normalize.js";
import {
  cleanCoordinate,
  cleanShort,
  cleanSummary,
  cleanTitle,
  cleanUrl,
} from "./sanitize.js";
import type { CandidateEvent, FetchedDocument } from "./types.js";

// Only genuine event types are accepted (FoodEvent etc. are excluded).
const ACCEPTED = new Set(["event", "sportsevent", "sportevent", "race"]);

const MAX_JSON_DEPTH = 6;

const MAX_TAG_CHARS = 1_000;

/** Linear-time scan for `<script type="application/ld+json">` bodies. */
export function extractJsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const lower = html.toLowerCase();
  let pos = 0;
  while (out.length < 50) {
    const open = lower.indexOf("<script", pos);
    if (open < 0) break;
    const tagEnd = lower.indexOf(">", open);
    if (tagEnd < 0) break;
    pos = tagEnd + 1;
    if (tagEnd - open > MAX_TAG_CHARS) continue;
    if (!lower.slice(open, tagEnd).includes("application/ld+json")) continue;
    const close = lower.indexOf("</script", pos);
    if (close < 0) break;
    try {
      out.push(JSON.parse(html.slice(pos, close).trim()));
    } catch {
      // Malformed JSON-LD is common; skip.
    }
    pos = close + 1;
  }
  return out;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typesOf(node: Json): string[] {
  const t = node["@type"];
  const list = Array.isArray(t) ? t : [t];
  return list
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.replace(/^.*[/#]/, "").toLowerCase());
}

function collectEventNodes(root: unknown, depth = 0, acc: Json[] = []): Json[] {
  if (
    depth > MAX_JSON_DEPTH ||
    acc.length >= CRAWLER_LIMITS.maxCandidatesPerDocument
  ) {
    return acc;
  }
  if (Array.isArray(root)) {
    for (const item of root) collectEventNodes(item, depth + 1, acc);
    return acc;
  }
  if (!isObj(root)) return acc;
  if (typesOf(root).some((t) => ACCEPTED.has(t))) acc.push(root);
  for (const key of [
    "@graph",
    "itemListElement",
    "item",
    "mainEntity",
    "subEvent",
  ]) {
    if (key in root) collectEventNodes(root[key], depth + 1, acc);
  }
  return acc;
}

function first(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

function nameOf(v: unknown): string | null {
  const x = first(v);
  if (typeof x === "string") return cleanShort(x);
  if (isObj(x)) return cleanShort(x.name);
  return null;
}

function parseLocation(loc: unknown): {
  city: string | null;
  country: CandidateEvent["countryCode"];
  foreign: boolean;
  venue: string | null;
  lat: number | null;
  lon: number | null;
} {
  const l = first(loc);
  const none = {
    city: null,
    country: null,
    foreign: false,
    venue: null,
    lat: null,
    lon: null,
  };
  if (typeof l === "string") return { ...none, venue: cleanShort(l) };
  if (!isObj(l)) return none;
  const addr = first(l.address);
  let city: string | null = null;
  let country: CandidateEvent["countryCode"] = null;
  let foreign = false;
  if (isObj(addr)) {
    city = cleanShort(addr.addressLocality);
    const c = isObj(addr.addressCountry)
      ? addr.addressCountry.name
      : addr.addressCountry;
    country = normalizeCountry(c);
    foreign = isForeignCountry(c);
  } else if (typeof addr === "string") {
    city = cleanShort(addr);
  }
  const geo = isObj(l.geo) ? l.geo : null;
  return {
    city,
    country,
    foreign,
    venue: cleanShort(l.name),
    lat: geo ? cleanCoordinate(geo.latitude, -90, 90) : null,
    lon: geo ? cleanCoordinate(geo.longitude, -180, 180) : null,
  };
}

function slugKey(title: string, start: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${slug}-${start.slice(0, 10)}`;
}

function toCandidate(node: Json, docUrl: string): CandidateEvent | null {
  const title = cleanTitle(node.name);
  const start = toIsoInstant(node.startDate);
  if (!title || !start) return null;

  const loc = parseLocation(node.location);
  // Event-specific URL only: never fall back to the page URL itself, or all
  // events on one page would collapse into one. A stable fragment keeps keys
  // distinct for pages that list several events without per-event links.
  const eventUrl =
    cleanUrl(node.url, docUrl) ??
    cleanUrl(`${docUrl}#${slugKey(title, start)}`, undefined, true);
  const offers = first(node.offers);
  const registrationUrl = isObj(offers) ? cleanUrl(offers.url, docUrl) : null;

  return {
    kind: "event",
    externalKey: eventUrl ?? `${docUrl}#${title}`,
    title,
    startDate: start,
    endDate: toIsoInstant(node.endDate),
    city: loc.city,
    countryCode: loc.country,
    ...(loc.foreign ? { foreignCountry: true } : {}),
    venueName: loc.venue,
    organizerName: nameOf(node.organizer),
    eventUrl,
    registrationUrl,
    summary: cleanSummary(node.description),
    latitude: loc.lat,
    longitude: loc.lon,
  };
}

/** Parse every schema.org Event in an HTML document. Never throws. */
export function parseJsonLdEvents(doc: FetchedDocument): CandidateEvent[] {
  try {
    const nodes = extractJsonLdBlocks(doc.body).flatMap((b) =>
      collectEventNodes(b),
    );
    const out: CandidateEvent[] = [];
    for (const n of nodes) {
      const c = toCandidate(n, doc.url);
      if (c) out.push(c);
      if (out.length >= CRAWLER_LIMITS.maxCandidatesPerDocument) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Same-host https links found in HTML (for optional detail-page following). */
export function extractLinks(
  html: string,
  base: string,
  pattern: RegExp,
  limit: number,
): string[] {
  const seen = new Set<string>();
  let baseHost = "";
  try {
    baseHost = new URL(base).host;
  } catch {
    return [];
  }
  const lower = html.toLowerCase();
  let pos = 0;
  let scanned = 0;
  while (seen.size < limit && scanned < 5_000) {
    const open = lower.indexOf("<a", pos);
    if (open < 0) break;
    scanned++;
    const end = lower.indexOf(">", open);
    if (end < 0) break;
    pos = end + 1;
    if (end - open > MAX_TAG_CHARS) continue;
    const m = /\shref\s*=\s*["']([^"']{1,500})["']/i.exec(
      html.slice(open, end),
    );
    if (!m) continue;
    const u = cleanUrl(m[1], base);
    if (!u) continue;
    try {
      if (new URL(u).host !== baseHost) continue;
    } catch {
      continue;
    }
    if (pattern.test(u)) seen.add(u);
  }
  return [...seen];
}
