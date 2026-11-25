import { readFile, readdir } from "node:fs/promises";
import { z } from "zod";
import { createIcalAdapter, createJsonLdAdapter } from "./engine/adapters.js";
import type { SourceConfig } from "./engine/types.js";

const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://"), "must use https");
export const sourceDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/),
  name: z.string().min(1).max(120),
  country: z.enum(["SK", "CZ"]),
  tier: z.enum(["green", "amber", "red"]),
  adapter: z.enum(["jsonld", "ical"]),
  startUrls: z.array(httpsUrl).min(1),
  allowedHosts: z.array(z.string().min(1)).min(1),
  maxPages: z.number().int().positive(),
  minDelayMs: z.number().int().nonnegative(),
  termsUrl: httpsUrl,
  termsCheckedAt: z.string().nullable(),
  robotsCheckedAt: z.string().nullable(),
  approvedBy: z.string().min(1).nullable(),
  approvedAt: z.string().datetime({ offset: true }).nullable(),
  enabled: z.boolean().default(false),
  notes: z.string(),
});
export type SourceDefinition = z.infer<typeof sourceDefinitionSchema>;

export function isSourceEligible(source: SourceDefinition): boolean {
  return (
    source.enabled &&
    source.approvedBy !== null &&
    source.approvedAt !== null &&
    source.tier === "green"
  );
}

export async function loadSources(
  directory = new URL("../sources/", import.meta.url),
): Promise<SourceDefinition[]> {
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".json"))
    .sort();
  return Promise.all(
    files.map(async (file) =>
      sourceDefinitionSchema.parse(
        JSON.parse(await readFile(new URL(file, directory), "utf8")),
      ),
    ),
  );
}

export function toEngineSource(source: SourceDefinition): SourceConfig {
  return {
    id: source.id,
    name: source.name,
    allowedHosts: source.allowedHosts,
    minDelayMs: source.minDelayMs,
    maxPages: source.maxPages,
    defaultCountry: source.country,
    adapter:
      source.adapter === "ical"
        ? createIcalAdapter(source.startUrls)
        : createJsonLdAdapter({ listUrls: source.startUrls }),
  };
}
