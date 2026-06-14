/**
 * T29 gate 1 — rule_conformance (BLOCK).
 *
 * The applicable rules (global ∪ mechanic) must have NO violations in the new
 * code. Reuses the G3 predicate engine (evaluatePredicate). A violation whose
 * anchors intersect the changed set fails the gate.
 *
 * SRP: this file only runs rule evaluation + scopes to the diff region.
 */

import type { GateResult } from "../../types.js";
import { evaluatePredicate } from "../../mechanics/engine.js";
import type { Gate, DiffInput } from "./types.js";
import { changedAnchors } from "./types.js";

export function ruleConformanceGate(): Gate {
  return {
    name: "rule_conformance",
    severity: "block",
    async run(input: DiffInput): Promise<GateResult> {
      const rules = input.rules ?? [];
      const changed = new Set(changedAnchors(input));

      const offending: string[] = [];
      const anchors = new Set<string>();

      for (const rule of rules) {
        const violations = await evaluatePredicate(rule.predicate, input.graph, {
          ruleId: rule.id,
          severity: rule.severity === "block" ? "error" : "warning",
        });
        for (const v of violations) {
          // Only count violations touching the diff region.
          if (v.anchors.some((a) => changed.has(a))) {
            offending.push(`${v.ruleId}: ${v.evidence}`);
            for (const a of v.anchors) anchors.add(a);
          }
        }
      }

      const pass = offending.length === 0;
      return {
        gate: "rule_conformance",
        pass,
        anchors: [...anchors].sort() as GateResult["anchors"],
        suggestion: pass
          ? null
          : "Fix rule violations in new code:\n" +
            [...new Set(offending)].sort().map((s) => `  - ${s}`).join("\n"),
      };
    },
  };
}
