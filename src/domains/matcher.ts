/**
 * T16 — Structural template matcher.
 *
 * Matches a parsed template pattern AST against a function body AST subtree,
 * binding metavariables ($NAME, uppercase) and honouring argument wildcards
 * ("..."). SRP: this file ONLY performs structural matching; template parsing
 * and Predicate compilation live in template.ts.
 *
 * Matching rules:
 *   - Exact node-type matching: a pattern node matches a code node only when
 *     their tree-sitter node types are equal (CallExpression vs Identifier, …).
 *   - Metavariable: a pattern identifier whose text is a metavar ($X) matches
 *     ANY single code node, binding $X to that node's text. A repeated metavar
 *     must bind consistently (same text) across occurrences.
 *   - Wildcard "...": inside an argument list (or any node child sequence),
 *     a metavar/identifier with text "..." (or "$...") matches zero-or-more
 *     remaining siblings.
 *   - Leaf tokens (operators, keywords) must match by text.
 *
 * The matcher walks NAMED children to stay resilient to incidental punctuation,
 * except that it also compares anonymous operator/keyword tokens by text so
 * that `a + b` does not match `a - b`.
 */

import type { AstNode } from "../types.js";

/** A successful match binds metavar name -> matched source text. */
export interface MatchResult {
  bindings: Map<string, string>;
}

const ENCODED_META_RE = /^ANATOMIA_META_([A-Z0-9_]+)$/;
const ENCODED_DOTS = "ANATOMIA_DOTS";

/** Decode an encoded metavar identifier back to its $NAME form, or null. */
export function decodeMetavar(text: string): string | null {
  const m = ENCODED_META_RE.exec(text.trim());
  return m ? "$" + m[1] : null;
}

/** Is this text an encoded metavariable token? */
export function isMetavar(text: string): boolean {
  return ENCODED_META_RE.test(text.trim());
}

/** Is this node a wildcard placeholder (encoded ...). */
function isWildcardNode(node: AstNode): boolean {
  return node.text.trim() === ENCODED_DOTS;
}

/**
 * Collect the meaningful children of a node for structural comparison:
 * named children plus anonymous operator/keyword tokens (text kept), dropping
 * pure punctuation like parentheses, commas and semicolons and any comments.
 */
function meaningfulChildren(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const child of node.children) {
    if (!child) continue;
    if (child.isExtra || child.type === "comment") continue;
    if (child.isNamed) {
      out.push(child);
      continue;
    }
    const txt = child.text.trim();
    if (txt.length === 0) continue;
    // Drop structural punctuation; keep operators/keywords (semantic).
    if (PUNCTUATION.has(txt)) continue;
    out.push(child);
  }
  return out;
}

const PUNCTUATION = new Set<string>([
  "(", ")", "{", "}", "[", "]", ",", ";", ":",
]);

/**
 * Try to match a single pattern node against a single code node, extending
 * `bindings`. Returns true on success (bindings mutated) or false on failure
 * (bindings may be partially mutated; caller discards on failure).
 */
function matchNode(
  pat: AstNode,
  code: AstNode,
  bindings: Map<string, string>,
): boolean {
  // Metavariable: matches any single node, binds consistently.
  const patText = pat.text.trim();
  const meta = decodeMetavar(patText);
  if (meta) {
    const existing = bindings.get(meta);
    const codeText = code.text.trim();
    if (existing !== undefined) return existing === codeText;
    bindings.set(meta, codeText);
    return true;
  }

  // Exact node-type match required for non-metavar nodes.
  if (pat.type !== code.type) return false;

  // Leaf: compare by text (operators, identifiers, literals, keywords).
  const patKids = meaningfulChildren(pat);
  const codeKids = meaningfulChildren(code);
  if (patKids.length === 0 && codeKids.length === 0) {
    return pat.text.trim() === code.text.trim();
  }

  return matchSequence(patKids, codeKids, bindings);
}

/**
 * Match a sequence of pattern children against code children, supporting a
 * single "..." wildcard that consumes zero-or-more code children.
 */
function matchSequence(
  pats: AstNode[],
  codes: AstNode[],
  bindings: Map<string, string>,
): boolean {
  const wildIndex = pats.findIndex((p) => isWildcardNode(p));

  if (wildIndex === -1) {
    if (pats.length !== codes.length) return false;
    for (let i = 0; i < pats.length; i++) {
      if (!matchNode(pats[i]!, codes[i]!, bindings)) return false;
    }
    return true;
  }

  // Split around the wildcard: prefix must match head, suffix must match tail.
  const prefix = pats.slice(0, wildIndex);
  const suffix = pats.slice(wildIndex + 1);
  if (codes.length < prefix.length + suffix.length) return false;

  for (let i = 0; i < prefix.length; i++) {
    if (!matchNode(prefix[i]!, codes[i]!, bindings)) return false;
  }
  const tailStart = codes.length - suffix.length;
  for (let j = 0; j < suffix.length; j++) {
    if (!matchNode(suffix[j]!, codes[tailStart + j]!, bindings)) return false;
  }
  return true;
}

/**
 * Attempt to match `patternRoot` somewhere within `codeRoot` (the function
 * body subtree). Returns the first MatchResult found (pre-order), or null.
 *
 * We try the pattern at every descendant node so that a pattern like
 * `$SKILL.mutate($STATE)` matches a call buried inside the body.
 */
export function matchTemplateAst(
  patternRoot: AstNode,
  codeRoot: AstNode,
): MatchResult | null {
  const stack: AstNode[] = [codeRoot];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const bindings = new Map<string, string>();
    if (matchNode(patternRoot, node, bindings)) {
      return { bindings };
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      const c = node.children[i];
      if (c) stack.push(c);
    }
  }
  return null;
}
