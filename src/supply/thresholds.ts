/**
 * T26 — Codebase-relative thresholds (DESIGN §9.2).
 *
 * "Coupling is too high" is NOT an absolute number — it's derived from the
 * repo's OWN distribution. For each metric we compute the median and the upper
 * percentile (default top-5% => the 95th percentile). A value is flagged when it
 * EXCEEDS that upper percentile. Kowloon Walled City is fine; only what is
 * abnormal *for this repo* is flagged.
 *
 * SRP: pure statistics over NodeMetrics[]. No graph access, no I/O.
 */

import type { MetricKey, NodeMetrics } from "./metrics.js";
import { METRIC_KEYS } from "./metrics.js";

export interface MetricThreshold {
  /** 50th-percentile (median) of the repo distribution. */
  median: number;
  /** Upper percentile cut (e.g. 95th) above which a value is flagged. */
  upper: number;
  /** Number of samples the distribution was derived from. */
  n: number;
}

export type Thresholds = Record<MetricKey, MetricThreshold>;

export interface DeriveOptions {
  /**
   * Upper percentile in [0,1]. Default 0.95 = top-5%. A value strictly greater
   * than this percentile is flagged.
   */
  upperPercentile?: number;
}

/**
 * Linear-interpolated percentile (R-7 / Excel "PERCENTILE.INC" convention).
 * `p` in [0,1]. Empty input => 0.
 */
export function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0]!;
  const clamped = Math.max(0, Math.min(1, p));
  const rank = clamped * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = rank - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

/** Extract one metric's values, ascending. */
function valuesFor(metrics: NodeMetrics[], key: MetricKey): number[] {
  return metrics.map((m) => m[key]).sort((a, b) => a - b);
}

/**
 * Derive per-metric thresholds from the repo's own distribution.
 *
 * @param metrics  Per-node metrics (computeMetrics output).
 * @param options  upperPercentile (default 0.95).
 */
export function deriveThresholds(
  metrics: NodeMetrics[],
  options: DeriveOptions = {},
): Thresholds {
  const upperP = options.upperPercentile ?? 0.95;
  const result = {} as Thresholds;
  for (const key of METRIC_KEYS) {
    const vals = valuesFor(metrics, key);
    result[key] = {
      median: percentile(vals, 0.5),
      upper: percentile(vals, upperP),
      n: vals.length,
    };
  }
  return result;
}

/**
 * True when `value` exceeds the repo's own upper percentile for `key`.
 * Strictly greater-than so a value exactly at the percentile is NOT flagged.
 */
export function isFlagged(
  thresholds: Thresholds,
  key: MetricKey,
  value: number,
): boolean {
  return value > thresholds[key].upper;
}
