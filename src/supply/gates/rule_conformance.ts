/**
 * T29 gate 1 — rule_conformance (BLOCK).
 *
 * The applicable rules (global ∪ domain) must have NO violations in the new
 * code. Reuses the G3 predicate engine (evaluatePredicate). A violation whose
 * anchors intersect the changed set fails the gate.
 *
 * SRP: this file only runs rule evaluation + scopes to the diff region.
 */

import type { GateResult } from "../../types.js";
import { evaluatePredicate } from "../../domains/engine.js";
import type { Gate, DiffInput } from "./types.js";
import { changedAnchors } from "./types.js";

export function ruleConformanceGate(): Gate {
  return {
    name: "rule_conformance",
    severity: "block",
    async run(input: DiffInput): Promise<GateResult> {
      const rules = input.rules ?? [];
      const changed = new Set(changedAnchors(input));

      // A `block` rule's violation fails the gate; a `warn` rule's violation is
      // advisory (listed in the suggestion, gate still passes). This lets domain
      // architecture rules guide without hard-blocking until promoted to block.
      const blocking: string[] = [];
      const advisory: string[] = [];
      const anchors = new Set<string>();

      for (const rule of rules) {
        const violations = await evaluatePredicate(rule.predicate, input.graph, {
          ruleId: rule.id,
          severity: rule.severity === "block" ? "error" : "warning",
        });
        for (const v of violations) {
          // Only count violations touching the diff region.
          if (!v.anchors.some((a) => changed.has(a))) continue;
          (rule.severity === "block" ? blocking : advisory).push(`${v.ruleId}: ${v.evidence}`);
          for (const a of v.anchors) anchors.add(a);
        }
      }

      const pass = blocking.length === 0;
      const lines: string[] = [];
      if (blocking.length > 0) {
        lines.push("Fix rule violations in new code:");
        lines.push(...[...new Set(blocking)].sort().map((s) => `  - ${s}`));
      }
      if (advisory.length > 0) {
        lines.push("Advisory (architecture warnings):");
        lines.push(...[...new Set(advisory)].sort().map((s) => `  - ${s}`));
      }
      return {
        gate: "rule_conformance",
        pass,
        anchors: [...anchors].sort() as GateResult["anchors"],
        suggestion: lines.length > 0 ? lines.join("\n") : null,
      };
    },
  };
}
