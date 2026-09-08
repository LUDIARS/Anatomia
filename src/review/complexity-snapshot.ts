/**
 * Per-function complexity snapshot for cross-checkout PR comparison.
 *
 * The aggregate PrComplexitySummary answers "how complex is this tree"; it
 * cannot answer "did THIS function get worse", because an average moves when
 * unrelated functions are added or removed. This snapshot publishes one row per
 * hashed function under a body-independent identity, so a base and a head
 * checkout can be compared function-by-function.
 */

import { createHash } from "node:crypto";
import { relative } from "node:path";
import type { FunctionNode } from "../types.js";
import type { NodeMetrics } from "../supply/metrics.js";

/** @spec Function complexity comparison */
export interface FunctionComplexitySnapshot {
  version: 1;
  metric: "call-out-degree-plus-one";
  functions: { key: string; structuralHash: string | null; value: number }[];
}

/**
 * Body-independent identities; never expose workstation paths or source text.
 *
 * Identity folds repo-relative path + enclosing type + name + signature shape,
 * excluding the body and line numbers, so a function keeps its key across a body
 * edit, a line shift and a different checkout root. Duplicate identities (true
 * overloads) are retained rather than deduplicated — consumers are told by the
 * spec not to pair ambiguous rows.
 *
 * `metrics` is derived from the same graph these `functions` built, so a missing
 * entry means the two drifted apart. That is a defect in the caller, not missing
 * data about the code, so it throws rather than publishing a snapshot whose gaps
 * a consumer would read as "function removed".
 */
export function buildComplexitySnapshot(
  repoPath: string,
  functions: FunctionNode[],
  metrics: NodeMetrics[],
): FunctionComplexitySnapshot {
  const byAnchor = new Map(metrics.map((metric) => [metric.anchor, metric.cyclomatic]));
  const rows = functions
    // Same guard as graph/build.ts addFunctionNode: an unhashed function is
    // never a graph node, so it has no metric by construction. Testing `!== null`
    // would admit `id: undefined` and turn that into the throw below.
    .filter((fn) => fn.id)
    .map((fn) => {
      const path = relative(repoPath, fn.sourceRange.filePath).replace(/\\/g, "/");
      const value = byAnchor.get(fn.id!);
      if (value === undefined) {
        // Name the function: an anonymous "missing metric" abort in the middle
        // of a whole PR review is undiagnosable. The repo-relative path keeps
        // the message free of workstation paths, as above.
        throw new Error(
          `Missing function complexity metric for "${fn.name}" (${path}:${fn.sourceRange.start.line})`,
        );
      }
      const identity = [path, fn.enclosingType ?? "", fn.name, fn.signatureShape ?? fn.signature];
      return {
        key: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
        structuralHash: fn.structuralHash ?? null,
        value,
      };
    });
  rows.sort((a, b) => a.key.localeCompare(b.key) || a.value - b.value);
  return { version: 1, metric: "call-out-degree-plus-one", functions: rows };
}
