/**
 * Production `Fetcher` for the engine: the SSRF-hardened `safeFetchText`
 * with the crawler user agent. Node built-ins only.
 */

import { CRAWLER_LIMITS } from "./limits.js";
import { safeFetchText } from "./safe-fetch.js";
import { CRAWLER_USER_AGENT, type Fetcher } from "./types.js";

export const safeCrawlerFetcher: Fetcher = (url, options) =>
  safeFetchText(url, {
    accept: options.accept,
    allowedContentTypes: [
      "text/html",
      "application/xhtml",
      "text/calendar",
      "application/json",
      "application/ld+json",
      "text/plain",
    ],
    maxBytes: options.maxBytes ?? CRAWLER_LIMITS.maxBodyBytes,
    userAgent: CRAWLER_USER_AGENT,
    // The polite layer re-checks allowlist + robots on every hop.
    manualRedirects: true,
  });
