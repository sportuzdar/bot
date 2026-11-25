/**
 * Generic source adapters. Per-source HTML adapters (B2) implement the same
 * `SourceAdapter` interface.
 */

import { extractLinks, parseJsonLdEvents } from "./jsonld.js";
import { parseIcalEvents } from "./ical.js";
import type { FetchedDocument, SourceAdapter } from "./types.js";

/** iCal feed(s): one document per feed URL. */
export function createIcalAdapter(feedUrls: string[]): SourceAdapter {
  return {
    fetchList: async (ctx) => {
      const docs: FetchedDocument[] = [];
      for (const u of feedUrls) {
        const d = await ctx.fetchDocument(u);
        if (d) docs.push(d);
      }
      return docs;
    },
    parse: parseIcalEvents,
  };
}

export interface JsonLdAdapterOptions {
  listUrls: string[];
  /** When set, same-host links matching this pattern are also fetched
   * (bounded by the polite fetcher's page cap). Use a non-global RegExp. */
  detailLinkPattern?: RegExp;
  maxDetailLinks?: number;
}

/** schema.org Event JSON-LD on listing pages and optionally detail pages. */
export function createJsonLdAdapter(opts: JsonLdAdapterOptions): SourceAdapter {
  return {
    fetchList: async (ctx) => {
      const docs: FetchedDocument[] = [];
      for (const u of opts.listUrls) {
        const list = await ctx.fetchDocument(u);
        if (!list) continue;
        docs.push(list);
        if (opts.detailLinkPattern) {
          const links = extractLinks(
            list.body,
            list.url,
            opts.detailLinkPattern,
            opts.maxDetailLinks ?? 20,
          );
          for (const link of links) {
            const d = await ctx.fetchDocument(link);
            if (d) docs.push(d);
          }
        }
      }
      return docs;
    },
    parse: parseJsonLdEvents,
  };
}
