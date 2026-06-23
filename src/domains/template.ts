/**
 * T16 — Template rules (by-example structural rules).
 *
 * A TemplateRule is a code fragment with metavariables ($NAME, uppercase) and
 * argument wildcards (...). It compiles to a TemplatePredicate (engine ADT) and
 * is evaluated by structurally matching the fragment against each function body
 * AST (matcher.ts).
 *
 * SRP: this file owns template parsing + compilation + evaluation orchestration;
 * the structural match algorithm lives in matcher.ts.
 *
 * Encoding: before parsing, $NAME -> ANATOMIA_META_NAME and ... -> ANATOMIA_DOTS
 * so the placeholders are valid identifiers (matcher.ts decodes them).
 *
 * Polarity:
 *   positive:true  -> the function MUST match the pattern; NOT matching is a
 *                     violation (a recommended/required shape).
 *   positive:false -> the function must NOT match the pattern; matching is a
 *                     violation (a forbidden shape, e.g. $SKILL.mutate($STATE)).
 */

import type { Tree } from "web-tree-sitter";
import type { AstNode, Lang, Predicate, Violation } from "../types.js";
import type { CodeGraphQuery } from "../graph/query.js";
import { parse } from "../dag/parser.js";
import { extractFunctions } from "../dag/extract.js";
import { matchTemplateAst, type MatchResult } from "./matcher.js";
import type { FunctionNode } from "../types.js";

/** A by-example structural template rule. */
export interface TemplateRule {
  /** Stable id; referenced by a TemplatePredicate. */
  id: string;
  /** The code fragment with $METAVARS and ... wildcards. */
  pattern: string;
  /** Declared metavariable names (without the leading $), e.g. ["SKILL"]. */
  metavars: string[];
  /** Fragment language. */
  language: Lang;
  /** true = must match; false = must NOT match. */
  positive: boolean;
  /** Optional human-readable description. */
  description?: string;
}

/** Encode $NAME -> ANATOMIA_META_NAME and ... -> ANATOMIA_DOTS. */
export function encodePattern(pattern: string): string {
  return pattern
    .replace(/\.\.\./g, "ANATOMIA_DOTS")
    .replace(/\$([A-Z_][A-Z0-9_]*)/g, "ANATOMIA_META_$1");
}

/**
 * Compile a TemplateRule into a TemplatePredicate. The predicate merely
 * references the template by id; evaluateTemplate performs the actual matching.
 */
export function compileTemplate(tpl: TemplateRule): Predicate {
  return { type: "TemplatePredicate", templateId: tpl.id };
}

/**
 * Extract the pattern root node from a parsed template tree. We wrap the
 * fragment in a function body when parsing, then descend to the first
 * meaningful statement / expression so the pattern is the fragment itself
 * (not the synthetic wrapper).
 */
function extractPatternRoot(tree: Tree): AstNode {
  // The fragment was wrapped as: void __anatomia_tpl__() { <fragment> }
  // Find that function, then its body, then the first meaningful child.
  const fns = extractFunctions(tree, "", "<template>");
  if (fns.length > 0 && fns[0]) {
    const body = fns[0].bodyAst;
    for (const child of body.namedChildren) {
      if (!child) continue;
      if (child.type === "comment" || child.isExtra) continue;
      // Unwrap a bare expression_statement to its expression.
      if (child.type === "expression_statement") {
        const inner = child.namedChildren.find((c) => c && !c.isExtra);
        if (inner) return inner;
      }
      return child;
    }
    return body;
  }
  return tree.rootNode;
}

/** Parse + encode a template fragment into its pattern root AST node. */
async function compilePatternAst(tpl: TemplateRule): Promise<{ tree: Tree; root: AstNode }> {
  const encoded = encodePattern(tpl.pattern);
  // Terminate a bare expression so it parses as a statement (not an ERROR).
  const trimmed = encoded.trimEnd();
  const stmt = /[;}]$/.test(trimmed) ? trimmed : trimmed + ";";
  const wrapped =
    tpl.language === "c_sharp"
      ? `class __A { void __anatomia_tpl__() { ${stmt} } }`
      : `void __anatomia_tpl__() { ${stmt} }`;
  const tree = await parse(wrapped, tpl.language);
  const root = extractPatternRoot(tree);
  return { tree, root };
}

/**
 * Structurally match a template against a single function body AST.
 * Returns the MatchResult (with metavar bindings) or null.
 *
 * NOTE: the caller must keep the underlying tree-sitter tree alive while the
 * FunctionNode.bodyAst is read (same constraint as the rest of the DAG layer).
 */
export async function matchTemplate(
  tpl: TemplateRule,
  fn: FunctionNode,
): Promise<MatchResult | null> {
  const { tree, root } = await compilePatternAst(tpl);
  try {
    return matchTemplateAst(root, fn.bodyAst);
  } finally {
    tree.delete();
  }
}

/**
 * Evaluate a template rule against a set of functions (whose bodyAst is live).
 *
 * The signature takes FunctionNode[] rather than CodeGraphQuery because
 * structural matching needs the AST subtree, which the graph projection does
 * not retain. Detection (T19) passes the same FunctionNodes used to build the
 * graph, so the two stay aligned by AnchorId.
 *
 * positive:true  -> a function that does NOT match yields a violation.
 * positive:false -> a function that DOES match yields a violation.
 */
export async function evaluateTemplate(
  tpl: TemplateRule,
  functions: FunctionNode[],
  ruleId = tpl.id,
): Promise<Violation[]> {
  const { tree, root } = await compilePatternAst(tpl);
  const out: Violation[] = [];
  try {
    for (const fn of functions) {
      if (!fn.id) continue;
      const match = matchTemplateAst(root, fn.bodyAst);
      const matched = match !== null;
      if (tpl.positive && !matched) {
        out.push({
          ruleId,
          anchors: [fn.id],
          evidence: `${fn.name} does not match required template "${tpl.id}"`,
          severity: "warning",
        });
      } else if (!tpl.positive && matched) {
        const binds = match
          ? [...match.bindings.entries()].map(([k, v]) => `${k}=${v}`).join(", ")
          : "";
        out.push({
          ruleId,
          anchors: [fn.id],
          evidence: `${fn.name} matches forbidden template "${tpl.id}"${binds ? " (" + binds + ")" : ""}`,
          severity: "error",
        });
      }
    }
  } finally {
    tree.delete();
  }
  return out;
}

/**
 * Build an engine TemplateResolver bound to a fixed set of functions, so the
 * predicate engine can resolve TemplatePredicate nodes (T14 injection point).
 */
export function makeTemplateResolver(
  templates: TemplateRule[],
  functions: FunctionNode[],
): (templateId: string, _g: CodeGraphQuery, ruleId: string) => Promise<Violation[]> {
  const byId = new Map(templates.map((t) => [t.id, t]));
  return async (templateId, _g, ruleId) => {
    const tpl = byId.get(templateId);
    if (!tpl) throw new Error(`unknown templateId: ${templateId}`);
    return evaluateTemplate(tpl, functions, ruleId);
  };
}
