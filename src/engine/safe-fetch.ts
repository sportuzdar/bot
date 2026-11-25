import dns from "node:dns";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import {
  MAX_REDIRECTS,
  isRedirectStatus,
  pickSafeAddresses,
  resolveRedirectTarget,
  validateImportUrl,
} from "./ssrf.js";

// SSRF-hardened GET for the crawler engine (portable: Node built-ins only;
// copied from apps/web/lib/submissions/safe-fetch.ts, PR #160).
// - every hop (initial URL and each redirect) is validated BEFORE connecting;
// - redirects are followed manually (max MAX_REDIRECTS);
// - the DNS answer is validated inside the socket `lookup` hook, so the
//   address we connect to is the address we checked (no resolve/connect gap);
// - https + port 443 only, no credentials, identity encoding, size + time caps.

const MAX_BODY_BYTES = 512 * 1024; // 512 KB
const TOTAL_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "SportuZdarBot/1.0 (+https://sportuzdar.sk)";

export interface SafeFetchTextOptions {
  /** `Accept` request header. */
  accept: string;
  /** Substrings of acceptable `Content-Type` values (empty = accept any). */
  allowedContentTypes: string[];
  maxBytes?: number;
  timeoutMs?: number;
  userAgent?: string;
  /** Return `redirect` (with `location`) instead of following it. */
  manualRedirects?: boolean;
}

export type SafeFetchTextResult =
  | {
      ok: true;
      status: number;
      body: string;
      contentType: string;
      finalUrl: string;
    }
  | { ok: false; error: string; status?: number; location?: string };

class SafeFetchError extends Error {}

const safeLookup: typeof dns.lookup = ((
  hostname: string,
  options: dns.LookupOptions | number | undefined,
  callback: (...args: unknown[]) => void,
) => {
  const opts: dns.LookupOptions =
    typeof options === "object" && options !== null ? options : {};
  dns.lookup(hostname, { ...opts, all: true, verbatim: true }, (err, addrs) => {
    if (err) return callback(err);
    const list = Array.isArray(addrs) ? addrs : [];
    const safe = pickSafeAddresses(list);
    if (!safe) return callback(new SafeFetchError("blocked-address"));
    if (opts.all) return callback(null, safe);
    return callback(null, safe[0]!.address, safe[0]!.family);
  });
}) as typeof dns.lookup;

function requestOnce(
  url: URL,
  deadline: number,
  accept: string,
  userAgent: string,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new SafeFetchError("timeout"));
    const req = https.request(
      {
        protocol: "https:",
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        lookup: safeLookup,
        agent: false,
        headers: {
          Host: url.host,
          "User-Agent": userAgent,
          Accept: accept,
          "Accept-Encoding": "identity",
        },
      },
      resolve,
    );
    const timer = setTimeout(() => {
      req.destroy(new SafeFetchError("timeout"));
    }, remaining);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
}

async function readCapped(
  res: IncomingMessage,
  deadline: number,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const timer = setTimeout(
    () => res.destroy(new SafeFetchError("timeout")),
    Math.max(0, deadline - Date.now()),
  );
  try {
    for await (const chunk of res) {
      const buf = chunk as Buffer;
      total += buf.byteLength;
      if (total > maxBytes) {
        res.destroy();
        throw new SafeFetchError("too-large");
      }
      chunks.push(buf);
    }
  } finally {
    clearTimeout(timer);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(
    Buffer.concat(chunks),
  );
}

/**
 * Generic SSRF-hardened GET (same guarantees as the file header). Non-2xx
 * responses are reported with their `status` so callers (robots.txt) can
 * distinguish 404 from 5xx. Error codes are stable machine strings.
 */
export async function safeFetchText(
  input: string,
  options: SafeFetchTextOptions,
): Promise<SafeFetchTextResult> {
  const first = validateImportUrl(input);
  if (!first.ok) return { ok: false, error: first.reason };

  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  const deadline = Date.now() + (options.timeoutMs ?? TOTAL_TIMEOUT_MS);
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  let current = first.url;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await requestOnce(
        current,
        deadline,
        options.accept,
        userAgent,
      );
      const status = res.statusCode ?? 0;

      if (isRedirectStatus(status) && options.manualRedirects) {
        res.destroy();
        const header = res.headers.location;
        return {
          ok: false,
          error: "redirect",
          status,
          location: Array.isArray(header) ? header[0] : header,
        };
      }

      if (isRedirectStatus(status)) {
        res.destroy();
        const header = res.headers.location;
        const next = resolveRedirectTarget(
          current,
          Array.isArray(header) ? header[0] : header,
        );
        if (!next) return { ok: false, error: "bad-redirect", status };
        const check = validateImportUrl(next);
        if (!check.ok) return { ok: false, error: "blocked-redirect", status };
        current = check.url;
        continue;
      }

      if (status < 200 || status >= 300) {
        res.destroy();
        return { ok: false, error: "http-status", status };
      }

      const contentType = String(res.headers["content-type"] ?? "");
      const lower = contentType.toLowerCase();
      if (
        options.allowedContentTypes.length > 0 &&
        !options.allowedContentTypes.some((t) => lower.includes(t))
      ) {
        res.destroy();
        return { ok: false, error: "content-type", status };
      }

      return {
        ok: true,
        status,
        contentType,
        finalUrl: current.toString(),
        body: await readCapped(res, deadline, maxBytes),
      };
    }
    return { ok: false, error: "too-many-redirects" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    const cause = (e as { cause?: unknown })?.cause;
    const text = `${msg} ${cause instanceof Error ? cause.message : ""}`;
    if (text.includes("timeout")) return { ok: false, error: "timeout" };
    if (text.includes("too-large")) return { ok: false, error: "too-large" };
    if (text.includes("blocked-address")) {
      return { ok: false, error: "blocked-address" };
    }
    return { ok: false, error: "network" };
  }
}
