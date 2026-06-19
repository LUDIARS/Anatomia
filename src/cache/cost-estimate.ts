/**
 * A-3 cache measurement — translate a hit tally into an estimated USD cost.
 *
 * The status surfaces ("did this session's cache help, and what is it worth?")
 * need money, not just a hit ratio. Each cache MISS is one LLM distillation call
 * that actually runs; each HIT is one such call avoided. So:
 *
 *   projected cost (no cache) = (hits + misses) × perCall
 *   actual    cost (this run) =            misses × perCall
 *   saved by cache            =  hits            × perCall
 *
 * `perCall` is the USD cost of one distillation call. When real LLM events were
 * recorded (an API key was set), we use their MEASURED mean tokens — the honest
 * number. When the warm server ran on the stub LLM (no key → 0 token events,
 * the common harness case), we fall back to ASSUMED per-call token sizes so the
 * figure is still meaningful; `basis` says which path was taken so callers can
 * label it "~" (estimate) vs measured.
 *
 * Pricing defaults to claude-opus-4-8 ($5/$25 per Mtok), Anatomia's default
 * distillation model. All knobs are env-overridable; nothing here calls an LLM.
 *
 * SRP: pure tally→cost arithmetic + env-resolved parameters. Aggregation lives
 * in stats.ts; event IO in transcript.ts.
 */
import type { CacheStatsReport, HitTally } from "./stats.js";

/** USD per 1M tokens for the distillation model. */
export interface ModelPricing {
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Assumed token size of one distillation call when no real calls were observed. */
export interface AssumedCallSize {
  inputTokens: number;
  outputTokens: number;
}

export interface CostEstimate {
  /** USD cost of one distillation call (measured mean, or assumed). */
  perCallUsd: number;
  /** "measured" = derived from real LLM token events; "assumed" = stub fallback. */
  basis: "measured" | "assumed";
  /** Hits × perCall — what the cache saved this slice. */
  savedUsd: number;
  /** Misses × perCall — what the runnable distillations cost this slice. */
  spentUsd: number;
  /** (hits + misses) × perCall — cost if the cache did not exist. */
  projectedUsd: number;
}

/** claude-opus-4-8 — Anatomia's default distillation model (ANATOMIA_LLM_MODEL). */
const DEFAULT_PRICING: ModelPricing = {
  model: "claude-opus-4-8",
  inputPerMTok: 5,
  outputPerMTok: 25,
};

/**
 * A domain-card distillation feeds the function source + a little context in and
 * gets a compact card JSON out. ~1500 in / ~400 out is a deliberately modest
 * default so the estimate never over-claims; override per workload via env.
 */
const DEFAULT_ASSUMED: AssumedCallSize = { inputTokens: 1500, outputTokens: 400 };

function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Resolve pricing + assumed call size from the environment (defaults = Opus 4.8). */
export function resolveCostParams(env: NodeJS.ProcessEnv = process.env): {
  pricing: ModelPricing;
  assumed: AssumedCallSize;
} {
  return {
    pricing: {
      model: env["ANATOMIA_COST_MODEL"]?.trim() || DEFAULT_PRICING.model,
      inputPerMTok: num(env["ANATOMIA_COST_INPUT_PER_MTOK"], DEFAULT_PRICING.inputPerMTok),
      outputPerMTok: num(env["ANATOMIA_COST_OUTPUT_PER_MTOK"], DEFAULT_PRICING.outputPerMTok),
    },
    assumed: {
      inputTokens: num(env["ANATOMIA_COST_CALL_INPUT_TOKENS"], DEFAULT_ASSUMED.inputTokens),
      outputTokens: num(env["ANATOMIA_COST_CALL_OUTPUT_TOKENS"], DEFAULT_ASSUMED.outputTokens),
    },
  };
}

function usd(inputTok: number, outputTok: number, p: ModelPricing): number {
  return (inputTok / 1_000_000) * p.inputPerMTok + (outputTok / 1_000_000) * p.outputPerMTok;
}

/**
 * Per-call USD cost. Prefers the MEASURED mean of the report's real LLM calls;
 * falls back to the ASSUMED call size when no real calls were observed.
 */
export function perCallUsd(
  report: CacheStatsReport,
  pricing: ModelPricing,
  assumed: AssumedCallSize,
): { perCallUsd: number; basis: "measured" | "assumed" } {
  if (report.llmCalls > 0) {
    const meanIn = report.tokens.inputTokens / report.llmCalls;
    const meanOut = report.tokens.outputTokens / report.llmCalls;
    return { perCallUsd: usd(meanIn, meanOut, pricing), basis: "measured" };
  }
  return { perCallUsd: usd(assumed.inputTokens, assumed.outputTokens, pricing), basis: "assumed" };
}

/** Apply a per-call cost to one hit tally (a session slice, namespace, or global). */
export function estimateForTally(
  tally: HitTally,
  perCall: number,
  basis: "measured" | "assumed",
): CostEstimate {
  return {
    perCallUsd: perCall,
    basis,
    savedUsd: tally.hits * perCall,
    spentUsd: tally.misses * perCall,
    projectedUsd: tally.gets * perCall,
  };
}

/**
 * Convenience: estimate cost for `report.global` (or a named session slice) using
 * env-resolved pricing. `session` selects `report.bySession[session]`; omit for
 * the global tally. Returns null when the requested slice has no events.
 */
export function estimateCost(
  report: CacheStatsReport,
  opts: { session?: string; env?: NodeJS.ProcessEnv } = {},
): CostEstimate | null {
  const tally = opts.session ? report.bySession[opts.session] : report.global;
  if (!tally || tally.gets === 0) return null;
  const { pricing, assumed } = resolveCostParams(opts.env ?? process.env);
  const { perCallUsd: per, basis } = perCallUsd(report, pricing, assumed);
  return estimateForTally(tally, per, basis);
}

const usd4 = (v: number): string => `$${v.toFixed(4)}`;

/** Human-readable cost block (CLI append under the hit-rate report). */
export function formatCost(cost: CostEstimate, env: NodeJS.ProcessEnv = process.env): string {
  const { pricing } = resolveCostParams(env);
  const tilde = cost.basis === "assumed" ? "~" : "";
  return [
    `estimated cost (${pricing.model}, ${cost.basis}):`,
    `  saved by cache:     ${tilde}${usd4(cost.savedUsd)}  (hits avoided)`,
    `  spent (misses):     ${tilde}${usd4(cost.spentUsd)}`,
    `  without cache:      ${tilde}${usd4(cost.projectedUsd)}`,
  ].join("\n");
}
