import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  crawlerIngestResponseSchema,
  type CrawlerIngestRequest,
} from "./contract/crawler.js";
import { buildBatches } from "./engine/batch.js";
import { safeCrawlerFetcher } from "./engine/fetcher.js";
import { runCrawl } from "./engine/run.js";
import { isSourceEligible, loadSources, toEngineSource } from "./sources.js";

/**
 * The bearer token may only ever be sent to the product's own hosts.
 * Extra hosts (e.g. a preview deployment) need an explicit, comma-separated
 * `CRAWLER_INGEST_ALLOWED_HOSTS`.
 */
export const DEFAULT_INGEST_HOSTS = ["sportuzdar.sk", "sportuzdar.cz"] as const;

export function allowedIngestHosts(extra = ""): Set<string> {
  return new Set([
    ...DEFAULT_INGEST_HOSTS,
    ...extra
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  ]);
}

interface SendDeps {
  url: string;
  token: string;
  allowedHosts?: Set<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export type SendResult =
  | { ok: true; status: number }
  | { ok: false; status?: number; stopSource: boolean };

export async function sendBatch(
  batch: CrawlerIngestRequest,
  deps: SendDeps,
): Promise<SendResult> {
  let endpoint: URL;
  try {
    endpoint = new URL(deps.url);
  } catch {
    return { ok: false, stopSource: true };
  }
  const allowedHosts = deps.allowedHosts ?? allowedIngestHosts();
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port !== "" ||
    !allowedHosts.has(endpoint.hostname.toLowerCase())
  ) {
    return { ok: false, stopSource: true };
  }
  const fetchImpl = deps.fetch ?? fetch;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${deps.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(batch),
        // A redirect could carry the bearer token to another host.
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        crawlerIngestResponseSchema.parse(await response.json());
        return { ok: true, status: response.status };
      }
      if ([401, 403, 404, 422].includes(response.status)) {
        return { ok: false, status: response.status, stopSource: true };
      }
      if (response.status < 500 || attempt === 2) {
        return { ok: false, status: response.status, stopSource: false };
      }
    } catch {
      if (attempt === 2) return { ok: false, stopSource: false };
    }
    await sleep(250 * 2 ** attempt);
  }
  return { ok: false, stopSource: false };
}

interface RunOptions {
  dryRun: boolean;
  sourceId?: string;
  out?: string;
}

export function parseRunOptions(args: string[]): RunOptions {
  const options: RunOptions = { dryRun: false };
  const valueOf = (flag: string, index: number): string => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`Missing value for ${flag}`);
    return value;
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--source") options.sourceId = valueOf(arg, index++);
    else if (arg === "--out") options.out = valueOf(arg, index++);
    else throw new Error(`Unknown option: ${arg ?? ""}`);
  }
  return options;
}

async function runCommand(args: string[]): Promise<number> {
  const options = parseRunOptions(args);
  const ingestUrl = process.env.CRAWLER_INGEST_URL;
  const ingestToken = process.env.CRAWLER_INGEST_TOKEN;
  const dryRun = options.dryRun || !ingestUrl || !ingestToken;
  const definitions = (await loadSources()).filter(
    (source) => !options.sourceId || source.id === options.sourceId,
  );
  if (options.sourceId && definitions.length === 0)
    throw new Error(`Unknown source: ${options.sourceId}`);
  const eligible = definitions.filter(isSourceEligible);
  if (options.sourceId && eligible.length === 0)
    throw new Error(
      `Source ${options.sourceId} is not eligible (needs enabled, approvedBy, approvedAt and tier green)`,
    );
  const result = await runCrawl(eligible.map(toEngineSource), {
    fetcher: safeCrawlerFetcher,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  });
  const byId = new Map(definitions.map((source) => [source.id, source]));
  const batches = result.sources.flatMap((sourceResult) => {
    const source = byId.get(sourceResult.report.sourceId);
    if (!source) return [];
    return buildBatches(
      { id: source.id, name: source.name },
      sourceResult.candidates,
      result.startedAt,
    );
  });

  if (dryRun) {
    const output = `${JSON.stringify(batches, null, 2)}\n`;
    if (options.out) await writeFile(options.out, output, "utf8");
    else process.stdout.write(output);
    return 0;
  }

  let failed = false;
  const stopped = new Set<string>();
  const allowedHosts = allowedIngestHosts(
    process.env.CRAWLER_INGEST_ALLOWED_HOSTS,
  );
  for (const batch of batches) {
    if (stopped.has(batch.source.id)) continue;
    const sent = await sendBatch(batch, {
      url: ingestUrl,
      token: ingestToken,
      allowedHosts,
    });
    if (!sent.ok) {
      failed = true;
      process.stderr.write(
        `Ingest failed for ${batch.source.id}${sent.status ? ` (${sent.status})` : ""}\n`,
      );
      if (sent.stopSource) stopped.add(batch.source.id);
    }
  }
  return failed ? 1 : 0;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = args;
  const sources =
    command === "list" || command === "check-source" ? await loadSources() : [];
  if (command === "list") {
    for (const source of sources)
      process.stdout.write(
        `${source.id}\t${isSourceEligible(source) ? "eligible" : "ineligible"}\n`,
      );
    return 0;
  }
  if (command === "check-source") {
    const source = sources.find((candidate) => candidate.id === rest[0]);
    if (!source) throw new Error(`Unknown source: ${rest[0] ?? ""}`);
    process.stdout.write(
      `${source.id}: ${isSourceEligible(source) ? "eligible" : "ineligible"}\n`,
    );
    return 0;
  }
  if (command === "run") return runCommand(rest);
  process.stderr.write(
    "Usage: bot run [--dry-run] [--source <id>] [--out <file>] | bot check-source <id> | bot list\n",
  );
  return 2;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Unexpected error"}\n`,
      );
      process.exitCode = 1;
    });
}
