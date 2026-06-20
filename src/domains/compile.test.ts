/**
 * compileDomainRules(ontology) — every domain preset rule becomes a Rule whose
 * id matches detect.ts's `${domain}/preset#${i}` convention, so a supplied rule
 * and its detected violation line up.
 */

import { describe, it, expect } from "vitest";
import { compileDomainRules } from "./compile.js";
import type { DomainOntology } from "./ontology.js";

function ontology(): DomainOntology {
  return {
    domains: new Map([
      [
        "ks-layer-spine",
        {
          name: "ks-layer-spine",
          description: "layer spine",
          presetRules: [
            { preset: "layerDependencyDirection", params: { layers: ["/util/", "/game/"], by: "path" } },
          ],
          templateRules: [],
        },
      ],
      [
        "two-rule",
        {
          name: "two-rule",
          description: "two presets",
          presetRules: [
            { preset: "noCycle", params: {} },
            { preset: "couplingCap", params: { targetPattern: ".*", maxFanOut: 8 } },
          ],
          templateRules: [],
        },
      ],
    ]),
  };
}

describe("compileDomainRules", () => {
  it("emits one Rule per preset rule with the detect.ts id convention", () => {
    const rules = compileDomainRules(ontology());
    const ids = rules.map((r) => r.id).sort();
    expect(ids).toEqual(["ks-layer-spine/preset#0", "two-rule/preset#0", "two-rule/preset#1"]);
  });

  it("builds a concrete predicate and defaults to warn severity / domain scope", () => {
    const rule = compileDomainRules(ontology()).find((r) => r.id === "ks-layer-spine/preset#0")!;
    expect(rule.severity).toBe("warn");
    expect(rule.scope).toBe("domain");
    // layerDependencyDirection over 2 layers → a single EdgeForbidden by path.
    expect(rule.predicate.type).toBe("EdgeForbidden");
    if (rule.predicate.type === "EdgeForbidden") {
      expect(rule.predicate.from.pathPattern).toBe("/util/");
      expect(rule.predicate.to.pathPattern).toBe("/game/");
    }
  });

  it("returns no rules for an empty ontology", () => {
    expect(compileDomainRules({ domains: new Map() })).toEqual([]);
  });
});
