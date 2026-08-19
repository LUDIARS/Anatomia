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

// ---------------------------------------------------------------------------
// Precomputed matches (low-memory analyze: run while ASTs are live)
// ---------------------------------------------------------------------------

/**
 * Content key identifying WHAT a template matches: language + pattern.
 * Matching is polarity-independent (positive/negative only changes how a match
 * turns into a violation), so two rules sharing a pattern share recorded
 * results. Keys FunctionNode.templateMatches / FileNode.templateKeys.
 */
export function templateMatchKey(tpl: TemplateRule): string {
  return `${tpl.language}\0${tpl.pattern}`;
}

/** Detached, reusable template AST prepared once for one analyze run. */
export interface PreparedTemplateMatcher {
  key: string;
  root: AstNode;
}

/** Binding summary string used in violation evidence ("K=V, K=V"). */
function bindsOf(match: MatchResult): string {
  return [...match.bindings.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
}

/** Inverse of bindsOf, for answering matchTemplate from a recorded result. */
function parseBinds(binds: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!binds) return map;
  for (const part of binds.split(", ")) {
    const eq = part.indexOf("=");
    if (eq > 0) map.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return map;
}

/**
 * Parse each distinct template once. extractPatternRoot returns a detached AST
 * mirror, so the native parser tree can be released before this returns.
 */
export async function prepareTemplateMatchers(
  templates: readonly TemplateRule[],
): Promise<PreparedTemplateMatcher[]> {
  const prepared: PreparedTemplateMatcher[] = [];
  for (const tpl of templates) {
    const compiled = await compilePatternAst(tpl);
    try {
      prepared.push({ key: templateMatchKey(tpl), root: compiled.root });
    } finally {
      compiled.tree.delete();
    }
  }
  return prepared;
}

/**
 * Match prepared templates against every function that still has a live bodyAst and
 * RECORD the result on the node (templateMatches[key] = binds | null). Called
 * by analyze() phase 1, per file, right before the ASTs are released — after
 * this, evaluateTemplate / matchTemplate answer from the recorded results and
 * never need the AST back. Keys already recorded are skipped (idempotent).
 */
export function recordTemplateMatches(
  templates: readonly PreparedTemplateMatcher[],
  functions: FunctionNode[],
): void {
  for (const tpl of templates) {
    for (const fn of functions) {
      if (!fn.bodyAst) continue;
      const rec = (fn.templateMatches ??= {});
      if (tpl.key in rec) continue;
      const match = matchTemplateAst(tpl.root, fn.bodyAst);
      rec[tpl.key] = match ? bindsOf(match) : null;
    }
  }
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
    // Freshly extracted from the parsed wrapper — the detached body is present.
    const body = fns[0].bodyAst!;
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
  throw new Error("template wrapper did not yield an extractable function body");
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
 * FunctionNode.bodyAst is a detached mirror, so the source parser tree need
 * not remain alive while matching.
 */
export async function matchTemplate(
  tpl: TemplateRule,
  fn: FunctionNode,
): Promise<MatchResult | null> {
  if (!fn.bodyAst) {
    // AST released — answer from the result recorded while it was live.
    const stored = fn.templateMatches?.[templateMatchKey(tpl)];
    if (stored === undefined || stored === null) return null;
    return { bindings: parseBinds(stored) };
  }
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
  const key = templateMatchKey(tpl);
  const out: Violation[] = [];
  // The pattern is compiled lazily: when every function carries a recorded
  // result (the low-memory analyze path), no parse happens at all.
  let compiled: { tree: Tree; root: AstNode } | null = null;
  try {
    for (const fn of functions) {
      if (!fn.id) continue;
      let matched: boolean;
      let binds = "";
      const stored = fn.templateMatches?.[key];
      if (stored !== undefined) {
        // Recorded while the AST was live (analyze phase 1 / disk cache).
        matched = stored !== null;
        binds = stored ?? "";
      } else if (fn.bodyAst) {
        compiled ??= await compilePatternAst(tpl);
        const match = matchTemplateAst(compiled.root, fn.bodyAst);
        matched = match !== null;
        binds = match ? bindsOf(match) : "";
      } else {
        // AST released and nothing recorded: analyze() only releases after
        // recording the active ontology's templates, so this is a foreign
        // template — treat as unmatched rather than crash.
        matched = false;
      }
      if (tpl.positive && !matched) {
        out.push({
          ruleId,
          anchors: [fn.id],
          evidence: `${fn.name} does not match required template "${tpl.id}"`,
          severity: "warning",
        });
      } else if (!tpl.positive && matched) {
        out.push({
          ruleId,
          anchors: [fn.id],
          evidence: `${fn.name} matches forbidden template "${tpl.id}"${binds ? " (" + binds + ")" : ""}`,
          severity: "error",
        });
      }
    }
  } finally {
    compiled?.tree.delete();
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
