/**
 * src/cost/feed.ts — Cross-service LLM cost feed (ingest store).
 *
 * Anatomia is the central cost-reduction surface. Other LUDIARS services
 * (Discutere, …) PUSH per-session cost summaries here via POST /api/cost-feed;
 * the panel renders them alongside the A-3 cache hit-rate.
 *
 * Each pushed row is a per-(session × model × backend) summary. A service may
 * re-push the same session as a discussion progresses, so aggregation keeps the
 * LATEST row per key (see aggregate.ts) rather than summing duplicates.
 *
 * Storage mirrors cache/transcript.ts: append-only JSONL gated by
 * ANATOMIA_COST_LOG (cross-process ground truth). With the env var unset we keep
 * an in-memory buffer so the dev panel still works within a single process.
 *
 * SRP: entry shape + JSONL append/read + env resolution ONLY.
 * Aggregation lives in aggregate.ts; HTTP routing in adapters/web/routes/cost.ts.
 */

import { appendFile, readFile } from "node:fs/promises";

/** One per-(session × model × backend) cost summary pushed by a service. */
export interface CostFeedEntry {
  /** When this summary was produced (epoch ms). Latest-per-key wins. */
  ts: number;
  /** Source service, e.g. "discutere". */
  service: string;
  /** The source service's own session/discussion id. */
  sessionId: string;
  model?: string;
  backend?: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /**
   * Estimated cost in USD. For subscription (claude-cli) this is an equivalent
   * API-price estimate, NOT real billing; usage-metered backends may report 0.
   */
  costUsd: number;
}

/** Sink + reader for cost-feed entries. `record` is fire-and-forget. */
export interface CostFeed {
  record(entry: CostFeedEntry): void;
  read(): Promise<CostFeedEntry[]>;
  /** Resolve once all queued writes have flushed. */
  flush(): Promise<void>;
}

/** In-memory feed (process lifetime). Used when ANATOMIA_COST_LOG is unset. */
export function createMemoryCostFeed(): CostFeed {
  const buf: CostFeedEntry[] = [];
  return {
    record(e) {
      buf.push(e);
    },
    async read() {
      return buf.slice();
    },
    async flush() {
      /* nothing queued */
    },
  };
}

/** JSONL-backed feed: append one line per entry, read parses the file back. */
export function createJsonlCostFeed(path: string): CostFeed {
  let queue: Promise<void> = Promise.resolve();
  return {
    record(e) {
      const line = JSON.stringify(e) + "\n";
      queue = queue.then(() => appendFile(path, line, "utf8").catch(() => undefined));
    },
    async read() {
      return readCostEntries(path);
    },
    async flush() {
      await queue;
    },
  };
}

/** Read + parse a cost-feed JSONL file. Bad lines are skipped, never fatal. */
export async function readCostEntries(path: string): Promise<CostFeedEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: CostFeedEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as CostFeedEntry;
      if (o && typeof o.service === "string" && typeof o.sessionId === "string") out.push(o);
    } catch {
      // skip unparseable / partially-written line
    }
  }
  return out;
}

let singleton: CostFeed | null = null;

/**
 * Process-wide cost feed resolved from the environment.
 * ANATOMIA_COST_LOG = path to a JSONL file (cross-process); unset => in-memory.
 */
export function getCostFeed(): CostFeed {
  if (singleton) return singleton;
  const logPath = process.env["ANATOMIA_COST_LOG"];
  singleton =
    logPath && logPath.trim() ? createJsonlCostFeed(logPath.trim()) : createMemoryCostFeed();
  return singleton;
}

/** Test hook: drop the cached singleton so the next getCostFeed() re-resolves. */
export function _resetCostFeed(): void {
  singleton = null;
}
