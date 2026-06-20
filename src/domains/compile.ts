/**
 * Compile a DomainOntology's preset rules into concrete Rule records.
 *
 * detect.ts compiles presets to predicates internally to *find violations*;
 * this module exposes the same preset rules as first-class Rule objects so the
 * supply bundle can list them (applicableRules) and the verify pipeline can
 * evaluate them. Rule ids match detect.ts's `${domain}/preset#${i}` convention
 * so a supplied rule and its detected violations line up.
 *
 * SRP: ontology → Rule[]. No evaluation (engine.ts), no detection (detect.ts).
 *
 * Template rules are intentionally not compiled here: they are AST-pattern
 * matchers, not Predicate-ADT rules, and are evaluated directly by detect.ts.
 */

import type { Rule } from "../types.js";
import type { DomainOntology } from "./ontology.js";
import { buildPresetPredicate } from "./presets.js";

/**
 * Build a Rule for every preset rule in every domain. Domain rules default to
 * `warn` severity: they advise (supply) and are reported (verify) without hard-
 * blocking an edit, which suits architecture guidance that a plugin author can
 * promote to `block` later.
 */
export function compileDomainRules(ontology: DomainOntology): Rule[] {
  const rules: Rule[] = [];
  for (const def of ontology.domains.values()) {
    def.presetRules.forEach((cfg, i) => {
      rules.push({
        id: `${def.name}/preset#${i}`,
        scope: "domain",
        description: def.description,
        predicate: buildPresetPredicate(cfg.preset, cfg.params),
        severity: "warn",
      });
    });
  }
  return rules;
}
