/**
 * A-3 cache measurement — aggregate a transcript into a hit-rate report.
 *
 * Pure function: CacheEvent[] -> CacheStatsReport. Because the A-3 cache is
 * shared, the report carries three views:
 *   - GLOBAL  : the shared cache's overall hit-rate (every session combined).
 *   - byNamespace : card vs phase distillation separately.
 *   - bySession   : each session's own slice — answers "did THIS terminal
 *                   session benefit, or only warm the cache for later ones?".
 *
 * `estimatedCallsSaved` = hits (each hit avoided exactly one LLM call). The
 * token estimate multiplies hits by the mean tokens of the calls actually made
 * (from llm events); it is labelled an ESTIMATE because the saved calls were, by
 * definition, never made.
 *
 * SRP: aggregation + formatting only. Event shape / IO live in transcript.ts.
 */
import type { CacheEvent, LlmUsage } from "./transcript.js";

export interface HitTally {
  gets: number;
  hits: number;
  misses: number;
  hitRate: number;
}

export interface CacheStatsReport {
  /** Global hit tally across all sessions + namespaces. */
  global: HitTally;
  byNamespace: Record<string, HitTally>;
  bySession: Record<string, HitTally>;
  /** Number of real LLM calls observed (= misses that reached the model). */
  llmCalls: number;
  /** Summed token usage of the real LLM calls. */
  tokens: LlmUsage;
  /** LLM/embedding-namespace hits — each avoided one real API call. */
  estimatedCallsSaved: number;
  /** llmHits × mean (input+output) tokens per observed call. ESTIMATE. */
  estimatedTokensSaved: number;
}

/**
 * Namespaces whose hits avoided a real LLM / embedding API call (the cost the
 * token estimate is about). The structural caches (analysis / perfile / graph /
 * detection / bundle) save CPU, not API calls, so they must NOT inflate
 * estimatedCallsSaved / estimatedTokensSaved — they still show in byNamespace.
 */
const LLM_NAMESPACES = new Set(["card", "phase", "embedding"]);

function emptyTally(): HitTally {
  return { gets: 0, hits: 0, misses: 0, hitRate: 0 };
}

function bump(t: HitTally, hit: boolean): void {
  t.gets++;
  if (hit) t.hits++;
  else t.misses++;
}

function finalize(t: HitTally): void {
  t.hitRate = t.gets === 0 ? 0 : t.hits / t.gets;
}

export function aggregate(events: CacheEvent[]): CacheStatsReport {
  const global = emptyTally();
  const byNamespace: Record<string, HitTally> = {};
  const bySession: Record<string, HitTally> = {};
  const tokens: LlmUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let llmCalls = 0;
  let llmHits = 0; // hits in LLM/embedding namespaces only (API calls avoided)

  for (const ev of events) {
    if (ev.kind === "get") {
      bump(global, ev.hit);
      (byNamespace[ev.ns] ??= emptyTally());
      bump(byNamespace[ev.ns], ev.hit);
      (bySession[ev.session] ??= emptyTally());
      bump(bySession[ev.session], ev.hit);
      if (ev.hit && LLM_NAMESPACES.has(ev.ns)) llmHits++;
    } else {
      llmCalls++;
      tokens.inputTokens += ev.usage.inputTokens;
      tokens.outputTokens += ev.usage.outputTokens;
      tokens.cacheReadTokens += ev.usage.cacheReadTokens;
      tokens.cacheCreationTokens += ev.usage.cacheCreationTokens;
    }
  }

  finalize(global);
  for (const t of Object.values(byNamespace)) finalize(t);
  for (const t of Object.values(bySession)) finalize(t);

  const meanCallTokens =
    llmCalls === 0 ? 0 : (tokens.inputTokens + tokens.outputTokens) / llmCalls;
  const estimatedTokensSaved = Math.round(llmHits * meanCallTokens);

  return {
    global,
    byNamespace,
    bySession,
    llmCalls,
    tokens,
    estimatedCallsSaved: llmHits,
    estimatedTokensSaved,
  };
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function tallyLine(label: string, t: HitTally): string {
  return `  ${label.padEnd(24)} ${String(t.hits).padStart(6)}/${String(t.gets).padEnd(6)} hit  (${pct(t.hitRate)})`;
}

/** Human-readable report (CLI default output). */
export function formatReport(r: CacheStatsReport): string {
  const lines: string[] = [];
  lines.push("Anatomia cache — hit rate (structural + LLM)");
  lines.push("");
  lines.push(tallyLine("GLOBAL", r.global));
  if (r.global.gets === 0) {
    lines.push("");
    lines.push("  (no cache events recorded — set ANATOMIA_CACHE_LOG and run analyze/verify)");
    return lines.join("\n");
  }
  lines.push("");
  lines.push("by namespace:");
  for (const [ns, t] of Object.entries(r.byNamespace).sort()) {
    lines.push(tallyLine(ns, t));
  }
  lines.push("");
  lines.push("by session:");
  for (const [s, t] of Object.entries(r.bySession).sort()) {
    lines.push(tallyLine(s, t));
  }
  lines.push("");
  lines.push(`LLM calls made:        ${r.llmCalls}`);
  lines.push(`  calls saved (hits):  ${r.estimatedCallsSaved}`);
  lines.push(
    `  tokens in/out:       ${r.tokens.inputTokens} / ${r.tokens.outputTokens}` +
      ` (prompt-cache read ${r.tokens.cacheReadTokens}, create ${r.tokens.cacheCreationTokens})`,
  );
  lines.push(`  est. tokens saved:   ~${r.estimatedTokensSaved} (hits × mean call size)`);
  return lines.join("\n");
}
