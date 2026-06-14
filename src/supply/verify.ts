/**
 * T29 — Verify: run the 5 gates -> structured Verdict (DESIGN §9.1 ③).
 *
 * Given a diff (changed/added functions) and an affected-graph region, run:
 *   1. rule_conformance (block)
 *   2. duplication      (block)
 *   3. spec_linkage     (warn -> block when strict)
 *   4. coupling_delta   (warn)
 *   5. convention_drift (warn)
 *
 * Verdict.pass = ALL block-severity gates pass. warn gates never fail the
 * verdict but their failures surface in the suggestion + per-gate results.
 *
 * Gates are injectable (so the duplication embedding client is mocked in tests).
 * `buildDefaultGates` wires the standard 5 with sensible defaults.
 *
 * SRP: orchestration + verdict aggregation only; each gate owns its logic.
 */

import type { GateResult, Verdict } from "../types.js";
import type { Gate, DiffInput, DuplicationDeps } from "./gates/types.js";
import { ruleConformanceGate } from "./gates/rule_conformance.js";
import { duplicationGate } from "./gates/duplication.js";
import { specLinkageGate } from "./gates/spec_linkage.js";
import { couplingDeltaGate } from "./gates/coupling_delta.js";
import { conventionDriftGate } from "./gates/convention_drift.js";

export interface VerifyOptions {
  /** Escalate spec_linkage from warn to block. Default false. */
  strictSpecLinkage?: boolean;
}

/**
 * Build the standard 5-gate set. The duplication gate needs an injected
 * embedding client (mocked in tests).
 */
export function buildDefaultGates(
  dupDeps: DuplicationDeps,
  options: VerifyOptions = {},
): Gate[] {
  return [
    ruleConformanceGate(),
    duplicationGate(dupDeps),
    specLinkageGate(options.strictSpecLinkage ?? false),
    couplingDeltaGate(),
    conventionDriftGate(),
  ];
}

/**
 * Run a set of gates against a diff and aggregate into a Verdict.
 * Gates run in array order; results are reported in that order.
 */
export async function verify(input: DiffInput, gates: Gate[]): Promise<Verdict> {
  const results: GateResult[] = [];
  const blockSeverity = new Map<GateResult["gate"], "block" | "warn">();

  for (const gate of gates) {
    blockSeverity.set(gate.name, gate.severity);
    results.push(await gate.run(input));
  }

  // verdict.pass = all BLOCK gates pass.
  const pass = results.every(
    (r) => r.pass || blockSeverity.get(r.gate) !== "block",
  );

  const failedAnchors = new Set<string>();
  const suggestions: string[] = [];
  for (const r of results) {
    if (r.pass) continue;
    for (const a of r.anchors) failedAnchors.add(a);
    const tier = blockSeverity.get(r.gate) === "block" ? "BLOCK" : "warn";
    if (r.suggestion) suggestions.push(`[${tier} ${r.gate}] ${r.suggestion}`);
  }

  return {
    pass,
    gates: results,
    anchors: [...failedAnchors].sort() as Verdict["anchors"],
    suggestion: suggestions.length > 0 ? suggestions.join("\n\n") : null,
  };
}
