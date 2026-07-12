/**
 * Verify-gate input derivation — thresholds + siblings for core.buildVerdict.
 *
 * coupling_delta and convention_drift are input-driven: without `thresholds`
 * (T26 repo-relative percentiles) and `siblings` (the local convention sample)
 * both gates return an unconditional pass. buildVerdict historically omitted
 * both fields, so 2 of the 5 gates were no-ops on the production CLI/MCP path
 * even though their own unit tests passed. This module derives the two fields
 * from the AnalysisContext so the gates actually run.
 *
 * SRP: DiffInput field derivation from an AnalysisContext only. Percentile
 * math stays in thresholds.ts, metric collection in metrics.ts.
 */

import type { FunctionNode } from "../types.js";
import type { AnalysisContext } from "../core.js";
import { computeMetrics, type DomainMembership } from "./metrics.js";
import { deriveThresholds, type Thresholds } from "./thresholds.js";

/** domain -> implementor anchors, from the context's detection results (G3). */
export function membershipOf(ctx: AnalysisContext): DomainMembership {
  const membership: DomainMembership = new Map();
  for (const d of ctx.domains ?? []) membership.set(d.domain, d.implementors);
  return membership;
}

// computeMetrics walks every node (fan counts + cross-domain DFS), which is too
// costly to repeat per verify on a warm server. The distribution depends only on
// the analyzed context, so memoize per ctx object: a re-analyze produces a new
// ctx and therefore a fresh derivation, while repeated verifies (and the
// per-file recursion of a multi-file diff) reuse the same promise.
const thresholdsCache = new WeakMap<AnalysisContext, Promise<Thresholds>>();

/** Repo-relative metric thresholds (T26) for the coupling_delta gate. */
export function verifyThresholds(ctx: AnalysisContext): Promise<Thresholds> {
  let cached = thresholdsCache.get(ctx);
  if (!cached) {
    cached = computeMetrics(ctx.graph, membershipOf(ctx)).then(deriveThresholds);
    thresholdsCache.set(ctx, cached);
  }
  return cached;
}

/** Same-file sample below which the sibling search widens to the directory. */
const MIN_FILE_SIBLINGS = 2;

/** Repo-relative, forward-slash form so diff paths match analyzed paths. */
function normalizeRel(path: string, repoPath: string): string {
  let p = path.replace(/\\/g, "/");
  const root = repoPath.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  if (p.startsWith(root)) p = p.slice(root.length);
  return p.replace(/^\.\//, "");
}

function dirOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "" : relPath.slice(0, idx);
}

/**
 * Sibling functions defining the local convention for the convention_drift
 * gate: functions of the changed file first (excluding the changed names —
 * new code must not vote on the convention it is checked against), widened to
 * the containing directory when the file offers too small a sample. Sorted by
 * name so the gate input (and thus the verdict) is deterministic.
 */
export function selectSiblings(
  ctx: AnalysisContext,
  targetPath: string | undefined,
  changed: FunctionNode[],
): FunctionNode[] {
  if (!targetPath) return [];
  const rel = normalizeRel(targetPath, ctx.repoPath);
  const dir = dirOf(rel);
  const changedNames = new Set(changed.map((f) => f.name));

  const inFile: FunctionNode[] = [];
  const inDir: FunctionNode[] = [];
  for (const fn of ctx.functions) {
    if (fn.id === null || changedNames.has(fn.name)) continue;
    const fnRel = normalizeRel(fn.sourceRange.filePath, ctx.repoPath);
    if (fnRel === rel) inFile.push(fn);
    else if (dirOf(fnRel) === dir) inDir.push(fn);
  }

  const picked = inFile.length >= MIN_FILE_SIBLINGS ? inFile : [...inFile, ...inDir];
  return picked.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
