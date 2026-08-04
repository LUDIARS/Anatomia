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
import { assertDomainDefinitionName } from "./assignment.js";
import { buildPresetPredicate } from "./presets.js";
import { invalidRegexParams } from "./regex-source.js";

/**
 * Build a Rule for every preset rule in every domain. Domain rules default to
 * `warn` severity: they advise (supply) and are reported (verify) without hard-
 * blocking an edit, which suits architecture guidance that a plugin author can
 * promote to `block` later.
 */
export function compileDomainRules(ontology: DomainOntology): Rule[] {
  const rules: Rule[] = [];
  for (const def of ontology.domains.values()) {
    assertDomainDefinitionName(def.name);
    def.presetRules.forEach((cfg, i) => {
      // 壊れた正規表現は 1 規則の損失に閉じ込める。ここで throw させると
      // 呼び出し側 (core.ts の domain detection) が全ドメインを捨ててしまい、
      // 「ドメインを定義したのに対象ドメイン無し」という診断困難な状態になる。
      const invalid = invalidRegexParams(cfg.params as Record<string, unknown>);
      if (invalid.length > 0) {
        for (const { key, pattern, problem } of invalid) {
          console.warn(
            `[anatomia/domains] ${def.name}/preset#${i} を無視しました: ${key}="${pattern}" は正規表現として不正です (${problem})`,
          );
        }
        return;
      }
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
