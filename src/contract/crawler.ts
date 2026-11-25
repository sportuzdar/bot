import { z } from "zod";

export const COUNTRY_CODES = ["SK", "CZ"] as const;
export const countryCodeSchema = z.enum(COUNTRY_CODES);
export type ApiCountryCode = z.infer<typeof countryCodeSchema>;

export const CRAWLER_SCHEMA_VERSION = 1 as const;
export const CRAWLER_MAX_CANDIDATES = 200;
export const CRAWLER_MAX_BODY_BYTES = 1_000_000;

export const crawlerSourceIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,59}$/, "source id must be lowercase [a-z0-9-]");

const httpsUrl = z
  .string()
  .max(500)
  .regex(
    /^https:\/\/[^\s@/?#]+([/?#]\S*)?$/,
    "must be an https URL without credentials",
  );
const isoInstant = z.string().max(40).datetime({ offset: true });

export const crawlerEventCandidateSchema = z.object({
  kind: z.literal("event"),
  externalKey: z.string().min(1).max(300),
  title: z.string().min(1).max(200),
  startDate: isoInstant,
  endDate: isoInstant.nullable(),
  city: z.string().max(120).nullable(),
  countryCode: countryCodeSchema.nullable(),
  venueName: z.string().max(120).nullable(),
  organizerName: z.string().max(120).nullable(),
  eventUrl: httpsUrl.nullable(),
  registrationUrl: httpsUrl.nullable(),
  summary: z.string().max(600).nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
});
export type CrawlerEventCandidate = z.infer<typeof crawlerEventCandidateSchema>;

export const crawlerCandidateSchema = z.discriminatedUnion("kind", [
  crawlerEventCandidateSchema,
]);
export type CrawlerCandidate = z.infer<typeof crawlerCandidateSchema>;

export const crawlerIngestRequestSchema = z.object({
  schemaVersion: z.literal(CRAWLER_SCHEMA_VERSION),
  source: z.object({
    id: crawlerSourceIdSchema,
    name: z.string().min(1).max(120),
  }),
  fetchedAt: isoInstant,
  candidates: z.array(crawlerCandidateSchema).max(CRAWLER_MAX_CANDIDATES),
});
export type CrawlerIngestRequest = z.infer<typeof crawlerIngestRequestSchema>;

export const CRAWLER_OUTCOMES = ["created", "duplicate", "rejected"] as const;
export const crawlerCandidateResultSchema = z.object({
  externalKey: z.string(),
  outcome: z.enum(CRAWLER_OUTCOMES),
  reason: z.string().optional(),
  submissionId: z.string().optional(),
});
export type CrawlerCandidateResult = z.infer<
  typeof crawlerCandidateResultSchema
>;
export const crawlerIngestResponseSchema = z.object({
  schemaVersion: z.literal(CRAWLER_SCHEMA_VERSION),
  sourceId: crawlerSourceIdSchema,
  counts: z.object({
    received: z.number().int(),
    created: z.number().int(),
    duplicate: z.number().int(),
    rejected: z.number().int(),
  }),
  results: z.array(crawlerCandidateResultSchema),
});
export type CrawlerIngestResponse = z.infer<typeof crawlerIngestResponseSchema>;
