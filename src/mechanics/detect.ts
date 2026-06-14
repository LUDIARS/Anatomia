/**
 * T19 — Mechanic detection (conformance).
 *
 * For each mechanic in an ontology, compile its presets + templates into
 * predicates, evaluate them against the graph, and report which functions
 * implement the mechanic, the violations found, and whether it conforms.
 *
 * SRP: this file orchestrates ontology -> predicates -> engine; it does not
 * define predicates (presets.ts), match templates (template.ts) or interpret
 * the ADT (engine.ts).
 *
 * "Implementors" = functions touched by the mechanic's rules: the set of nodes
 * matched by any NodeFilter appearing in the mechanic's compiled predicates,
 * unioned with the anchors that appear in template matches. "conforms" is true
 * when no `error`-severity violation is found for that mechanic.
 */

import type {
  AnchorId,
  FunctionNode,
  NodeFilter,
  Predicate,
  Violation,
} from "../types.js";
import type { CodeGraphQuery } from "../graph/query.js";
import { evaluatePredicate } from "./engine.js";
import { buildPresetPredicate } from "./presets.js";
import { evaluateTemplate, makeTemplateResolver } from "./template.js";
import { matchesFilter } from "./predicate.js";
import type { MechanicDef, MechanicOntology } from "./ontology.js";

export interface DetectionResult {
  mechanic: string;
  /** Functions that implement (are touched by) the mechanic. */
  implementors: AnchorId[];
  /** All violations found for the mechanic. */
  violations: Violation[];
  /** True iff no error-severity violation was found. */
  conforms: boolean;
}

/** Collect every NodeFilter referenced anywhere in a predicate tree. */
function collectFilters(pred: Predicate, out: NodeFilter[]): void {
  switch (pred.type) {
    case "EdgeForbidden":
      out.push(pred.from, pred.to);
      break;
    case "FanInCap":
    case "FanOutCap":
      out.push(pred.target);
      break;
    case "NoCycle":
      out.push(pred.scope);
      break;
    case "And":
    case "Or":
      for (const c of pred.children) collectFilters(c, out);
      break;
    case "Not":
      collectFilters(pred.child, out);
      break;
    case "TemplatePredicate":
      break;
  }
}

/** Compile a mechanic def's preset rules into predicates. */
function compilePresetPredicates(def: MechanicDef): Predicate[] {
  return def.presetRules.map((cfg) => buildPresetPredicate(cfg.preset, cfg.params));
}

/**
 * Detect a single mechanic against the graph + its backing functions.
 */
export async function detectMechanic(
  def: MechanicDef,
  graph: CodeGraphQuery,
  functions: FunctionNode[],
): Promise<DetectionResult> {
  const presetPreds = compilePresetPredicates(def);
  const templateResolver = makeTemplateResolver(def.templateRules, functions);

  // Evaluate preset predicates through the engine.
  const violations: Violation[] = [];
  for (let i = 0; i < presetPreds.length; i++) {
    const ruleId = `${def.name}/preset#${i}`;
    const v = await evaluatePredicate(presetPreds[i]!, graph, {
      ruleId,
      severity: "error",
      templateResolver,
    });
    violations.push(...v);
  }

  // Evaluate template rules directly (they need live AST via functions).
  for (const tpl of def.templateRules) {
    const v = await evaluateTemplate(tpl, functions, `${def.name}/${tpl.id}`);
    violations.push(...v);
  }

  // Implementors: nodes matched by any filter in the preset predicates, plus
  // any anchor appearing in template matches (positive matches) / violations.
  const filters: NodeFilter[] = [];
  for (const p of presetPreds) collectFilters(p, filters);

  const allNodes = await graph.allNodes();
  const implementorSet = new Set<AnchorId>();
  for (const node of allNodes) {
    if (filters.some((f) => isMeaningfulFilter(f) && matchesFilter(node, f))) {
      implementorSet.add(node.id);
    }
  }

  // Add anchors that matched templates (positive) so template-only mechanics
  // still report implementors.
  for (const tpl of def.templateRules) {
    if (!tpl.positive) continue;
    for (const fn of functions) {
      if (!fn.id) continue;
      // A positive template that did NOT produce a violation = it matched.
      // Re-run match to record the implementor.
      const matched = await templateMatched(tpl, fn);
      if (matched) implementorSet.add(fn.id);
    }
  }

  const conforms = !violations.some((v) => v.severity === "error");
  return {
    mechanic: def.name,
    implementors: [...implementorSet],
    violations,
    conforms,
  };
}

/** A filter is "meaningful" if it actually constrains (not match-everything). */
function isMeaningfulFilter(f: NodeFilter): boolean {
  if (f.kind !== undefined) return true;
  if (f.tags && f.tags.length > 0) return true;
  if (f.namePattern !== undefined) {
    // ".*" and "" match everything -> not meaningful for implementor scoping.
    return f.namePattern !== ".*" && f.namePattern !== "";
  }
  return false;
}

async function templateMatched(
  tpl: import("./template.js").TemplateRule,
  fn: FunctionNode,
): Promise<boolean> {
  const { matchTemplate } = await import("./template.js");
  const r = await matchTemplate(tpl, fn);
  return r !== null;
}

/**
 * Detect all mechanics in an ontology.
 */
export async function detectMechanics(
  ontology: MechanicOntology,
  graph: CodeGraphQuery,
  functions: FunctionNode[],
): Promise<DetectionResult[]> {
  const results: DetectionResult[] = [];
  for (const def of ontology.mechanics.values()) {
    results.push(await detectMechanic(def, graph, functions));
  }
  return results;
}
