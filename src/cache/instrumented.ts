/**
 * A-3 cache measurement — a CacheStore decorator that records hit/miss.
 *
 * Wraps any CacheStore<V> and reports each `get` to a CacheTranscript as a
 * hit (value present) or miss (absent => the caller will invoke the LLM). This
 * is the seam where the otherwise-silent content cache becomes observable, with
 * zero change to the distillation logic in card.ts / label.ts. `set` is a pure
 * passthrough (every miss leads to a set, so a separate set event is redundant).
 *
 * An in-process counter is also kept so a single run can summarise itself without
 * re-reading the file; cross-session aggregation uses the transcript (stats.ts).
 *
 * SRP: decoration + counting only. Event shape / IO live in transcript.ts.
 */
import type { CacheStore } from "./store.js";
import type { CacheTranscript } from "./transcript.js";

/** Running per-process tally of cache gets. */
export interface CacheCounters {
  gets: number;
  hits: number;
  misses: number;
}

export function createCounters(): CacheCounters {
  return { gets: 0, hits: 0, misses: 0 };
}

/** hits / gets, or 0 when there were no gets (avoids NaN). */
export function hitRate(c: CacheCounters): number {
  return c.gets === 0 ? 0 : c.hits / c.gets;
}

export interface InstrumentOptions {
  /** Cache namespace recorded on every event ("card" | "phase"). */
  ns: string;
  /** Sink for events. */
  transcript: CacheTranscript;
  /**
   * Session id stamped on every event. A plain string tags every event with one
   * id (single-process callers). A resolver `() => string` is evaluated at the
   * moment each event is recorded, so a long-running shared server can tag events
   * with a per-request session id (see cache/session-context.ts) while falling
   * back to its process-global id between requests.
   */
  session: string | (() => string);
  /** Model id folded into the key (diagnostic only). */
  model?: string;
  /** Optional shared counter to accumulate into (created if omitted). */
  counters?: CacheCounters;
}

/**
 * Decorate `inner` so each get records a hit/miss event to the transcript and
 * bumps the counters. Returns the wrapped store plus its counters (so a caller
 * can read the in-process tally after the run).
 */
export function instrumentStore<V>(
  inner: CacheStore<V>,
  opts: InstrumentOptions,
): { store: CacheStore<V>; counters: CacheCounters } {
  const counters = opts.counters ?? createCounters();
  const resolveSession = typeof opts.session === "function" ? opts.session : () => opts.session as string;
  const store: CacheStore<V> = {
    async get(key) {
      const value = await inner.get(key);
      const hit = value !== undefined;
      counters.gets++;
      if (hit) counters.hits++;
      else counters.misses++;
      opts.transcript.record({
        kind: "get",
        ts: Date.now(),
        session: resolveSession(),
        ns: opts.ns,
        hit,
        key,
        model: opts.model,
      });
      return value;
    },
    async set(key, value) {
      await inner.set(key, value);
    },
  };
  return { store, counters };
}
