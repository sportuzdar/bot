# Crawler engine (portable)

Copy this folder verbatim into the `sportuzdar-bot` repo. Imports only its own
files and Node built-ins; no npm runtime dependencies (tests use `tsx --test`).

- `types.ts` - adapter interface, `CandidateEvent` (wire shape of `packages/api/src/crawler.ts`, schemaVersion 1)
- `run.ts` - `runCrawl(sources, {fetcher, sleep, now})` -> candidates per source (in-run dedup, caps)
- `batch.ts` - `buildBatches()` -> `POST /api/internal/crawler/ingest` bodies (max 200 candidates)
- `adapters.ts`, `jsonld.ts`, `ical.ts` - generic schema.org Event JSON-LD and iCal adapters
- `politeness.ts`, `robots.ts` - robots.txt, rate limit, page caps, host allowlist, per-hop redirect checks
- `fetcher.ts`, `safe-fetch.ts`, `ssrf.ts` - SSRF-safe fetch (https:443, DNS-pinned, manual redirects)
- `sanitize.ts`, `normalize.ts`, `dedup.ts`, `datetime.ts`, `limits.ts` - helpers
- tests: `parsers.test.ts`, `run.test.ts`, `ssrf.test.ts`
