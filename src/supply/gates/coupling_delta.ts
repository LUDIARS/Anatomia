/**
 * T29 gate 4 — coupling_delta (WARN).
 *
 * Flags changed functions whose coupling / shared-state fan-in EXCEEDS the
 * repo's OWN upper percentile (T26 thresholds, DESIGN §9.2). Codebase-relative,
 * not absolute: Kowloon is fine, only repo-abnormal coupling is flagged.
 *
 * For each changed anchor we read fanIn/fanOut/coupling and the reads+writes
 * (shared-state) fan-in from the POST-change graph, and compare against the
 * derived thresholds. If a baseGraph is supplied we additionally require the
 * metric to have *increased* vs base (a pre-existing hotspot the diff did not
 * worsen is not flagged) — this is the "delta" semantics.
 *
 * SRP: per-anchor threshold comparison only; threshold derivation is T26's job.
 */

import type { AnchorId, GateResult } from "../../types.js";
import type { CodeGraphQuery } from "../../graph/query.js";
import { isFlagged } from "../thresholds.js";
import type { MetricKey } from "../metrics.js";
import type { Gate, DiffInput } from "./types.js";
import { changedAnchors } from "./types.js";

async function couplingOf(graph: CodeGraphQuery, id: AnchorId): Promise<number> {
  const c = await graph.fanCounts(id);
  return c.fanIn + c.fanOut;
}

async function sharedStateFanInOf(graph: CodeGraphQuery, id: AnchorId): Promise<number> {
  const reads = (await graph.fanCounts(id, "reads")).fanIn;
  const writes = (await graph.fanCounts(id, "writes")).fanIn;
  return reads + writes;
}

export function couplingDeltaGate(): Gate {
  return {
    name: "coupling_delta",
    severity: "warn",
    async run(input: DiffInput): Promise<GateResult> {
      const thresholds = input.thresholds;
      const anchors = changedAnchors(input);

      // Without thresholds there is nothing repo-relative to compare against.
      if (!thresholds) {
        return { gate: "coupling_delta", pass: true, anchors: [], suggestion: null };
      }

      const flagged: { anchor: AnchorId; metric: MetricKey; value: number }[] = [];

      for (const id of anchors) {
        const coupling = await couplingOf(input.graph, id);
        const stateFanIn = await sharedStateFanInOf(input.graph, id);

        const checks: { metric: MetricKey; value: number }[] = [
          { metric: "coupling", value: coupling },
          { metric: "sharedStateFanIn", value: stateFanIn },
        ];

        for (const { metric, value } of checks) {
          if (!isFlagged(thresholds, metric, value)) continue;
          // Delta semantics: if a base graph is given, only flag an increase.
          if (input.baseGraph) {
            const baseVal =
              metric === "coupling"
                ? await couplingOf(input.baseGraph, id).catch(() => 0)
                : await sharedStateFanInOf(input.baseGraph, id).catch(() => 0);
            if (value <= baseVal) continue; // not worsened by this diff
          }
          flagged.push({ anchor: id, metric, value });
        }
      }

      const pass = flagged.length === 0;
      const flaggedAnchors = [...new Set(flagged.map((f) => f.anchor))].sort();
      return {
        gate: "coupling_delta",
        pass,
        anchors: flaggedAnchors as GateResult["anchors"],
        suggestion: pass
          ? null
          : "Coupling/shared-state fan-in exceeds this repo's upper percentile:\n" +
            flagged
              .map(
                (f) =>
                  `  - ${f.anchor}: ${f.metric}=${f.value} > p95=${thresholds[f.metric].upper}`,
              )
              .sort()
              .join("\n"),
      };
    },
  };
}
