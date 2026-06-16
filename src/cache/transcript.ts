/**
 * A-3 cache measurement — append-only transcript of cache events (DESIGN §9 obs).
 *
 * The A-3 LLM cache is content-addressed and SHARED across sessions / repos /
 * machines (file store under ANATOMIA_CACHE_DIR). That sharing is exactly what
 * makes its hit-rate hard to judge from a single terminal session: a hit may be
 * a payoff your own session warmed, or one a prior session left behind. To
 * measure it honestly we record every cache GET (hit|miss) and every real LLM
 * call as one JSONL line tagged with a per-process sessionId, so `cache-stats`
 * can report both the GLOBAL shared-cache hit-rate AND each session's own slice.
 *
 * The transcript is the cross-process ground truth: multiple sessions append to
 * the same file (small O_APPEND writes), and aggregation reads it back. Recording
 * is fire-and-forget and never throws — measurement must not break analysis.
 *
 * SRP: event shape + JSONL append/read + env/session resolution ONLY.
 * Aggregation lives in stats.ts; the store decorator in instrumented.ts.
 */
import { appendFile, readFile } from "node:fs/promises";

/** Token usage of one real LLM call (Anthropic Messages `usage`). */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic prompt-cache read tokens (0 when the prompt cache is unused). */
  cacheReadTokens: number;
  /** Anthropic prompt-cache creation tokens. */
  cacheCreationTokens: number;
}

/** A single cache GET: hit (served from store, no LLM) or miss (LLM was called). */
export interface GetEvent {
  kind: "get";
  ts: number;
  session: string;
  /** Namespace of the cache: "card" (domain cards) or "phase" (phase labels). */
  ns: string;
  hit: boolean;
  /** Versioned content key (sha256 hex). */
  key: string;
  /** Model id folded into the key (diagnostic). */
  model?: string;
}

/** A single real LLM call (only happens on a cache miss). */
export interface LlmEvent {
  kind: "llm";
  ts: number;
  session: string;
  model: string;
  usage: LlmUsage;
}

export type CacheEvent = GetEvent | LlmEvent;

/** Sink for cache events. `record` is fire-and-forget; `flush` awaits writes. */
export interface CacheTranscript {
  record(event: CacheEvent): void;
  /** Resolve once all queued writes have been flushed to disk. */
  flush(): Promise<void>;
}

/** A no-op transcript (the default — zero overhead when measurement is off). */
export function createNullTranscript(): CacheTranscript {
  return {
    record() {
      /* discard */
    },
    async flush() {
      /* nothing queued */
    },
  };
}

/**
 * A JSONL transcript appending one line per event to `path`. Writes are
 * serialized through a promise chain so lines from this process never interleave;
 * cross-process appends rely on O_APPEND atomicity for the small per-line writes.
 * Any write error is swallowed (a measurement failure must never fail analysis).
 */
export function createJsonlTranscript(path: string): CacheTranscript {
  let queue: Promise<void> = Promise.resolve();
  return {
    record(event) {
      const line = JSON.stringify(event) + "\n";
      queue = queue.then(
        () => appendFile(path, line, "utf8").catch(() => undefined),
      );
    },
    async flush() {
      await queue;
    },
  };
}

/**
 * Per-process session id. Stable for the lifetime of the process so every event
 * it records shares one id. Overridable via ANATOMIA_SESSION_ID (lets a wrapper
 * such as Lictor correlate a terminal session with its cache events).
 */
export function resolveSessionId(): string {
  const explicit = process.env["ANATOMIA_SESSION_ID"];
  if (explicit && explicit.trim()) return explicit.trim();
  return `${process.pid}-${Date.now().toString(36)}`;
}

/**
 * Resolve the transcript from the environment. ANATOMIA_CACHE_LOG = path to the
 * JSONL transcript file; unset => null transcript (measurement off). The session
 * id is resolved once here so callers share it across card + phase + llm events.
 */
export function resolveTranscript(): { transcript: CacheTranscript; session: string; enabled: boolean } {
  const logPath = process.env["ANATOMIA_CACHE_LOG"];
  const session = resolveSessionId();
  if (logPath && logPath.trim()) {
    return { transcript: createJsonlTranscript(logPath.trim()), session, enabled: true };
  }
  return { transcript: createNullTranscript(), session, enabled: false };
}

/** Read + parse a JSONL transcript file. Bad lines are skipped, never fatal. */
export async function readEvents(path: string): Promise<CacheEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: CacheEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as CacheEvent;
      if (obj && (obj.kind === "get" || obj.kind === "llm")) out.push(obj);
    } catch {
      // skip unparseable / partially-written line
    }
  }
  return out;
}
