/**
 * T19 — Domain detection (conformance).
 *
 * For each domain in an ontology, compile its presets + templates into
 * predicates, evaluate them against the graph, and report which functions
 * implement the domain, the violations found, and whether it conforms.
 *
 * @spec ドメイン検出（G3）
 *
 * SRP: this file orchestrates ontology -> predicates -> engine; it does not
 * define predicates (presets.ts), match templates (template.ts) or interpret
 * the ADT (engine.ts).
 *
 * "Implementors" = functions touched by the domain's rules: the set of nodes
 * matched by any NodeFilter appearing in the domain's compiled predicates,
 * unioned with the anchors that appear in template matches. "conforms" is true
 * when no `error`-severity violation is found for that domain.
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
import { invalidRegexParams } from "./regex-source.js";
import type { DomainDef, DomainOntology, DomainRole } from "./ontology.js";
import { assertDomainDefinitionName } from "./assignment.js";

export interface DetectionResult {
  domain: string;
  /** Missing is treated as semantic for legacy callers and cached fixtures. */
  role?: DomainRole;
  /**
   * The definition's human-written description, carried through so consumers
   * that rank domains against a natural-language task (supply/detectors.ts,
   * supply/plan) can read what the domain IS. Without it a Japanese task could
   * only be matched against ASCII identifiers and never overlapped. Optional:
   * cached fixtures written before this field exist and simply score without it.
   */
  description?: string;
  /** Functions that implement (are touched by) the domain. */
  implementors: AnchorId[];
  /** All violations found for the domain. */
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

/**
 * Compile a domain def's preset rules into predicates.
 *
 * 正規表現が壊れている規則は落とす。ここで例外を投げると呼び出し元がドメイン検出
 * 全体を諦めるため、1 パターンの誤りで全ドメインが消える (実測: `(?i)auth` 1 つで
 * 13 ドメイン全滅)。compile.ts と同じ方針。
 */
function compilePresetPredicates(def: DomainDef): Predicate[] {
  return def.presetRules
    .filter((cfg) => invalidRegexParams(cfg.params as Record<string, unknown>).length === 0)
    .map((cfg) => buildPresetPredicate(cfg.preset, cfg.params));
}

/** Namespace local template ids while preserving legacy already-qualified ids. */
function qualifyTemplateRuleId(domain: string, ruleId: string): string {
  const prefix = `${domain}/`;
  return ruleId.startsWith(prefix) ? ruleId : `${prefix}${ruleId}`;
}

/**
 * Detect a single domain against the graph + its backing functions.
 */
export async function detectDomain(
  def: DomainDef,
  graph: CodeGraphQuery,
  functions: FunctionNode[],
): Promise<DetectionResult> {
  assertDomainDefinitionName(def.name);
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
    const v = await evaluateTemplate(
      tpl,
      functions,
      qualifyTemplateRuleId(def.name, tpl.id),
    );
    violations.push(...v);
  }

  // Implementors: nodes matched by any filter in the preset predicates, plus
  // the domain's declarative `membership` filters (ownership, no violation),
  // plus any anchor appearing in template matches (positive matches).
  const filters: NodeFilter[] = [];
  for (const p of presetPreds) collectFilters(p, filters);
  for (const m of def.membership ?? []) filters.push(m);

  const allNodes = await graph.allNodes();
  const functionByAnchor = new Map(
    functions.flatMap((fn) => (fn.id ? [[fn.id, fn] as const] : [])),
  );
  const implementorSet = new Set<AnchorId>();
  for (const node of allNodes) {
    const fn = functionByAnchor.get(node.id);
    const filterNode = fn
      ? {
          ...node,
          ...(fn.signatureShape !== undefined
            ? { signatureShape: fn.signatureShape }
            : {}),
        }
      : node;
    if (
      filters.some(
        (filter) =>
          isMeaningfulFilter(filter) && matchesFilter(filterNode, filter),
      )
    ) {
      implementorSet.add(node.id);
    }
  }

  // Add anchors that matched templates (positive) so template-only domains
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
    domain: def.name,
    role: def.role ?? "semantic",
    description: def.description,
    implementors: [...implementorSet],
    violations,
    conforms,
  };
}

/** A filter is "meaningful" if it actually constrains (not match-everything). */
function isMeaningfulFilter(f: NodeFilter): boolean {
  if (f.kind !== undefined) return true;
  if (f.tags && f.tags.length > 0) return true;
  if (f.pathPattern !== undefined && f.pathPattern !== ".*" && f.pathPattern !== "") {
    return true;
  }
  if (f.namePattern !== undefined) {
    // ".*" and "" match everything -> not meaningful for implementor scoping.
    if (f.namePattern !== ".*" && f.namePattern !== "") return true;
  }
  if (f.signatureShapePattern !== undefined) {
    return f.signatureShapePattern !== ".*" && f.signatureShapePattern !== "";
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
 * Detect all domains in an ontology.
 */
export async function detectDomains(
  ontology: DomainOntology,
  graph: CodeGraphQuery,
  functions: FunctionNode[],
): Promise<DetectionResult[]> {
  const results: DetectionResult[] = [];
  for (const def of ontology.domains.values()) {
    results.push(await detectDomain(def, graph, functions));
  }
  return results;
}

/** Keep policy evaluation observable without making it semantic ownership. */
export function partitionDetectionResults(results: readonly DetectionResult[]): {
  domains: DetectionResult[];
  policyResults: DetectionResult[];
} {
  const domains: DetectionResult[] = [];
  const policyResults: DetectionResult[] = [];
  for (const result of results) {
    if (isSemanticDetectionResult(result)) domains.push(result);
    else policyResults.push(result);
  }
  return { domains, policyResults };
}

/** Runtime guard for public consumers that interpret results as ownership. */
export function isSemanticDetectionResult(result: DetectionResult): boolean {
  return result.role === undefined || result.role === "semantic";
}

/**
 * Remove policy evaluations before deriving cards, views, scenes, or other
 * semantic ownership. Legacy results without a role remain semantic.
 */
export function semanticDetectionResults(
  results: readonly DetectionResult[],
): DetectionResult[] {
  return results.filter(isSemanticDetectionResult);
}

/** Fail closed when a single-result API is asked to materialize a policy. */
export function assertSemanticDetectionResult(result: DetectionResult): void {
  if (!isSemanticDetectionResult(result)) {
    throw new Error(
      `policy result "${result.domain}" cannot be used as semantic domain ownership`,
    );
  }
}
