# SportuZdar Bot

SportuZdar Bot is a zero-cost public event crawler for SportuZdar. It collects only public event facts—such as event names, dates, locations, sports, distances, organizer names, registration links, and source links—and sends candidates to a human review queue. Every published event links back to its source.

The bot never collects personal data, bypasses logins, accesses paywalled pages, evades anti-bot protections, or uses a headless browser or LLM. It respects `robots.txt`, strict per-source limits, and owner approval. Its user agent is `SportuZdarBot/1.0 (+https://sportuzdar.sk/bot)`.

For questions or opt-out requests, contact `bot@sportuzdar.sk`.

## Run locally

Requires Node.js 24 and pnpm 10.8.1.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm bot list
pnpm bot check-source example-disabled
pnpm bot run --dry-run
```

`bot run` automatically uses dry-run mode when `CRAWLER_INGEST_URL` or `CRAWLER_INGEST_TOKEN` is missing. Dry runs print JSON to stdout, or write it with `--out <file>`. Use `--source <id>` to select one registry entry.

## Source approval

Sources live as JSON files in `sources/`. New entries default to disabled. A source is runnable only when all four conditions hold: it is enabled, its tier is `green`, `approvedBy` is set, and `approvedAt` is set. Before approval, an owner reviews the source terms, robots policy, allowed hosts, adapter, and request limits. Contributors must never enable a source themselves.

The bot has no database credentials. Configured production runs send schema-versioned batches over HTTPS to the web application's crawler ingest endpoint with a bearer token; the receiver revalidates every candidate and places it in `pending_review`.
