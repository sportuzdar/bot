/**
 * iCalendar (RFC 5545 subset) VEVENT parser. Pure and defensive.
 *
 * Time zones: `...Z` is UTC; floating / `TZID=Europe/...` values are read as
 * Europe/Bratislava wall time (SK/CZ share the zone); `VALUE=DATE` is
 * all-day (end is exclusive per RFC, converted to the last day).
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

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function unfold(text: string): string[] {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function parseProp(line: string): Prop | null {
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const head = line.slice(0, colon).split(";");
  const name = head[0]!.toUpperCase();
  const params: Record<string, string> = {};
  for (const p of head.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name, params, value: line.slice(colon + 1) };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** DTSTART/DTEND value → UTC ISO instant; `allDayEnd` makes DATE ends inclusive. */
function icalDate(p: Prop, allDayEnd = false): string | null {
  const v = p.value.trim();
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (d) {
    let [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    if (allDayEnd) {
      const prev = new Date(Date.UTC(y, m - 1, day - 1, 12));
      [y, m, day] = [
        prev.getUTCFullYear(),
        prev.getUTCMonth() + 1,
        prev.getUTCDate(),
      ];
    }
    return toIsoInstant(`${y}-${pad(m)}-${pad(day)}`);
  }
  const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/.exec(v);
  if (!t) return null;
  // Local times are read as Bratislava wall time; only Europe/* zones are
  // trusted to mean that, any other TZID is rejected rather than mis-shifted.
  const tzid = p.params.TZID;
  if (!t[7] && tzid && !/^"?Europe\//.test(tzid)) return null;
  const [, y, mo, da, h, mi, s, z] = t;
  if (z) {
    return toIsoInstant(`${y}-${mo}-${da}T${h}:${mi}:${s ?? "00"}Z`);
  }
  return toIsoInstant(`${y}-${mo}-${da}T${h}:${mi}:${s ?? "00"}`);
}

export function parseIcalEvents(doc: FetchedDocument): CandidateEvent[] {
  try {
    const lines = unfold(doc.body);
    const out: CandidateEvent[] = [];
    let cur: Prop[] | null = null;
    for (const line of lines) {
      const up = line.trim().toUpperCase();
      if (up === "BEGIN:VEVENT") {
        cur = [];
        continue;
      }
      if (up === "END:VEVENT") {
        if (cur) {
          try {
            const c = vevent(cur, doc.url);
            if (c) out.push(c);
          } catch {
            // One malformed VEVENT must not drop the rest of the feed.
          }
        }
        cur = null;
        if (out.length >= CRAWLER_LIMITS.maxCandidatesPerDocument) break;
        continue;
      }
      if (cur) {
        const p = parseProp(line);
        if (p) cur.push(p);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function vevent(props: Prop[], feedUrl: string): CandidateEvent | null {
  const get = (n: string) => props.find((p) => p.name === n);
  const status = get("STATUS")?.value.trim().toUpperCase();
  if (status === "CANCELLED") return null;

  const dtstart = get("DTSTART");
  const title = cleanTitle(unescapeText(get("SUMMARY")?.value ?? ""));
  if (!dtstart || !title) return null;
  const start = icalDate(dtstart);
  if (!start) return null;
  const dtend = get("DTEND");
  const isDate =
    dtend?.params.VALUE === "DATE" || /^\d{8}$/.test(dtend?.value.trim() ?? "");
  const end = dtend ? icalDate(dtend, isDate) : null;

  const uid = cleanShort(get("UID")?.value) ?? title;
  const eventUrl =
    cleanUrl(get("URL")?.value) ??
    cleanUrl(`${feedUrl}#${encodeURIComponent(uid)}`, undefined, true);

  const geo = get("GEO")?.value.split(";");
  const location = cleanShort(unescapeText(get("LOCATION")?.value ?? ""));
  const countryText = location ? location.split(",").pop()?.trim() : undefined;
  const country = normalizeCountry(countryText);
  const foreign = isForeignCountry(countryText) && location!.includes(",");

  return {
    kind: "event",
    externalKey: uid,
    title,
    startDate: start,
    endDate: end && Date.parse(end) >= Date.parse(start) ? end : null,
    city: null,
    countryCode: country,
    ...(foreign ? { foreignCountry: true } : {}),
    venueName: location,
    organizerName: cleanShort(unescapeText(get("ORGANIZER")?.params.CN ?? "")),
    eventUrl,
    registrationUrl: null,
    summary: cleanSummary(unescapeText(get("DESCRIPTION")?.value ?? "")),
    latitude: geo ? cleanCoordinate(geo[0], -90, 90) : null,
    longitude: geo ? cleanCoordinate(geo[1], -180, 180) : null,
  };
}
