// Pure SSRF helpers for the URL import (no I/O, unit-tested with node:test).
// See design/decisions/2026-11-19-ssrf-import-hardening.md.

import { isIP } from "node:net";

const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost", ".localdomain"];

/** Parse dotted-quad IPv4 into 4 octets, or null. */
function parseIPv4(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

/** Parse IPv6 text (no brackets / zone) into 8 16-bit groups, or null. */
function parseIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4)
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    s =
      s.slice(0, lastColon + 1) +
      ((v4[0]! << 8) | v4[1]!).toString(16) +
      ":" +
      ((v4[2]! << 8) | v4[3]!).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = parse(halves[1]!);
  if (!rest) return null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

function isBlockedIPv4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 "this" network
    a === 10 || // 10/8
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    a === 127 || // 127/8 loopback
    (a === 169 && b === 254) || // 169.254/16 link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 0 && c === 0) || // 192.0.0/24 IETF protocol
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) || // 192.168/16
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast 224/4, reserved 240/4, broadcast
  );
}

function isBlockedIPv6(g: number[]): boolean {
  const v4From = (hi: number, lo: number) => [
    hi >> 8,
    hi & 255,
    lo >> 8,
    lo & 255,
  ];
  const first5Zero = g.slice(0, 5).every((x) => x === 0);
  if (g.slice(0, 7).every((x) => x === 0) && g[7]! <= 1) return true; // :: and ::1
  if (first5Zero && g[5] === 0xffff) return isBlockedIPv4(v4From(g[6]!, g[7]!)); // ::ffff:a.b.c.d
  if (first5Zero && g[5] === 0) return true; // ::/96 deprecated IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedIPv4(v4From(g[6]!, g[7]!)); // 64:ff9b::/96 NAT64
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // 64:ff9b:1::/48 local NAT64
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard
  if (g[0] === 0x2001 && g[1] === 0) return true; // 2001::/32 Teredo
  if (g[0] === 0x2002) return isBlockedIPv4(v4From(g[1]!, g[2]!)); // 6to4
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 docs
  return false;
}

/**
 * True when `ip` (v4 or v6 literal, optionally bracketed) is not a safe public
 * destination. Anything unparseable is blocked (fail closed).
 */
export function isBlockedIp(ip: string): boolean {
  const raw = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const kind = isIP(raw.split("%")[0]!);
  if (kind === 4) {
    const o = parseIPv4(raw);
    return o ? isBlockedIPv4(o) : true;
  }
  if (kind === 6) {
    const g = parseIPv6(raw);
    return g ? isBlockedIPv6(g) : true;
  }
  return true;
}

/** Hostname-level check: IP literals, localhost-ish names, reserved suffixes. */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "" || h === "localhost") return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (isIP(bare.split("%")[0]!) !== 0) return isBlockedIp(bare);
  // WHATWG URL already normalises 0x7f.1 / 2130706433 to dotted quads; a
  // leftover all-numeric / hex label is ambiguous, so refuse it.
  if (/^[0-9.]+$/.test(h) || /^0x[0-9a-f.]*$/.test(h)) return true;
  return false;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Validate one hop: https only, port 443 only, no credentials, public host. */
export function validateImportUrl(input: string | URL): UrlCheck {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "protocol" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  if (url.port !== "" && url.port !== "443")
    return { ok: false, reason: "port" };
  if (isBlockedHostname(url.hostname)) return { ok: false, reason: "host" };
  return { ok: true, url };
}

export const MAX_REDIRECTS = 3;

export function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

/** Resolve a Location header against the current hop; null when unusable. */
export function resolveRedirectTarget(
  current: URL,
  location: string | undefined,
): URL | null {
  if (!location) return null;
  try {
    return new URL(location, current);
  } catch {
    return null;
  }
}

/**
 * Filter DNS answers: every returned address must be public, otherwise the
 * whole lookup is refused (a mixed public/private answer is a rebinding smell).
 */
export function pickSafeAddresses<T extends { address: string }>(
  answers: T[],
): T[] | null {
  if (answers.length === 0) return null;
  return answers.every((a) => !isBlockedIp(a.address)) ? answers : null;
}
