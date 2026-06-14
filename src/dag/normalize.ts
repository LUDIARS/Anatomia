/**
 * T05 — Function normalization (alpha-normalization).
 *
 * Produce a canonical string for a function body subtree so that
 * formatting / comments / local-variable renames collapse to the SAME string,
 * while a change in the body's *structure* (different logic) produces a
 * different string. (DESIGN section 4.2)
 *
 * Strategy
 *   1. Comments / extras are already separate AST nodes; we skip `isExtra`.
 *   2. Local declarations and parameters are alpha-renamed to positional
 *      indices ($v0, $v1, ... in declaration order; $p0, $p1, ... in parameter
 *      order).
 *   3. Public symbols are KEPT verbatim: type names, called function names,
 *      member/field names, namespace-qualified names, literals.
 *   4. Output is a deterministic S-expression of node types + meaningful leaf
 *      tokens, so whitespace never appears and operators stay distinguishable.
 */

import type { Node } from "web-tree-sitter";

/** Identifier node kinds that may denote a *local variable use*. */
const VARIABLE_IDENTIFIER_TYPES = new Set<string>([
  "identifier", // C++ & C# plain identifier
]);

/** Identifier kinds we always keep verbatim (public meaning). */
const KEPT_IDENTIFIER_TYPES = new Set<string>([
  "field_identifier",
  "type_identifier",
  "namespace_identifier",
  "primitive_type",
  "qualified_identifier",
  "scoped_identifier",
]);

/** Node types whose `.text` is a literal token we keep verbatim. */
const LITERAL_TYPES = new Set<string>([
  "number_literal",
  "integer_literal",
  "real_literal",
  "string_literal",
  "raw_string_literal",
  "char_literal",
  "character_literal",
  "true",
  "false",
  "null",
  "nullptr",
  "this",
  "concatenated_string",
]);

/** Declaration node types that bind one or more local variable names. */
const LOCAL_DECL_TYPES = new Set<string>([
  // C++
  "declaration",
  "init_declarator",
  // C#
  "variable_declarator",
]);

interface RenameMap {
  /** original local-variable name -> $vN */
  vars: Map<string, string>;
  /** original parameter name -> $pN */
  params: Map<string, string>;
}

/** Walk a parameter list and collect parameter names in order. */
function collectParamNames(funcNode: Node, params: Map<string, string>): void {
  const paramList =
    funcNode.childForFieldName("parameters") ??
    funcNode.descendantsOfType("parameter_list")[0] ??
    null;
  if (!paramList) return;
  for (const p of paramList.namedChildren) {
    if (!p) continue;
    const name = findBoundIdentifier(p);
    if (name && !params.has(name)) {
      params.set(name, "$p" + params.size);
    }
  }
}

/**
 * Find the variable name bound by a declarator / parameter node: descend the
 * declarator chain to the innermost plain `identifier`.
 */
function findBoundIdentifier(node: Node): string | null {
  // C# parameter / variable_declarator expose `name`.
  const nameField = node.childForFieldName("name");
  if (nameField && nameField.type === "identifier") return nameField.text;

  // C++ declarator chain.
  const declarator = node.childForFieldName("declarator");
  if (declarator) {
    const inner = findBoundIdentifier(declarator);
    if (inner) return inner;
  }
  if (node.type === "identifier") return node.text;
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === "identifier") return child.text;
  }
  return null;
}

/** First pass: collect every local declaration name in declaration order. */
function collectLocalNames(node: Node, vars: Map<string, string>): void {
  if (LOCAL_DECL_TYPES.has(node.type)) {
    if (node.type === "declaration") {
      // A C++ `declaration` may bind several init_declarators / identifiers.
      let bound = false;
      for (const child of node.namedChildren) {
        if (!child) continue;
        if (child.type === "init_declarator" || child.type === "identifier") {
          const name = findBoundIdentifier(child);
          if (name && !vars.has(name)) {
            vars.set(name, "$v" + vars.size);
            bound = true;
          }
        }
      }
      if (!bound) {
        const direct = findBoundIdentifier(node);
        if (direct && !vars.has(direct)) vars.set(direct, "$v" + vars.size);
      }
    } else {
      // C# variable_declarator (or C++ bare init_declarator).
      const name = findBoundIdentifier(node);
      if (name && !vars.has(name)) vars.set(name, "$v" + vars.size);
    }
  }
  for (const child of node.namedChildren) {
    if (child) collectLocalNames(child, vars);
  }
}

/** Build the rename map for a body subtree (params come from the parent fn). */
function buildRenameMap(body: Node): RenameMap {
  const vars = new Map<string, string>();
  const params = new Map<string, string>();
  const fn = body.parent;
  if (fn) collectParamNames(fn, params);
  collectLocalNames(body, vars);
  return { vars, params };
}

/** Render a leaf identifier, applying alpha-rename if it is a known local/param. */
function renderIdentifier(node: Node, map: RenameMap): string {
  const t = node.text;
  const v = map.vars.get(t);
  if (v) return "(id " + v + ")";
  const p = map.params.get(t);
  if (p) return "(id " + p + ")";
  // Kept verbatim (call name, free symbol, type used as value, etc.).
  return "(id " + t + ")";
}

/** Recursively emit a canonical S-expression for `node`. */
function emit(node: Node, map: RenameMap): string {
  // Drop comments and other "extra" nodes entirely.
  if (node.isExtra || node.type === "comment") return "";

  if (VARIABLE_IDENTIFIER_TYPES.has(node.type)) {
    return renderIdentifier(node, map);
  }
  if (KEPT_IDENTIFIER_TYPES.has(node.type)) {
    return "(sym " + node.text + ")";
  }
  if (LITERAL_TYPES.has(node.type)) {
    return "(lit " + node.text + ")";
  }

  const parts: string[] = [];
  for (const child of node.children) {
    if (!child) continue;
    if (child.isExtra || child.type === "comment") continue;
    if (child.isNamed) {
      const sub = emit(child, map);
      if (sub) parts.push(sub);
    } else {
      // Anonymous token: operators / keywords carry meaning (a+b vs a-b).
      const txt = child.text.trim();
      if (txt.length > 0) parts.push("(t " + txt + ")");
    }
  }
  return "(" + node.type + (parts.length ? " " + parts.join(" ") : "") + ")";
}

/**
 * Normalize a function body subtree to a deterministic canonical string.
 *
 * @param node   the body subtree (compound_statement / block)
 * @param _source unused (kept for the documented T05 signature; node.text
 *                 already exposes the relevant slice)
 */
export function normalize(node: Node, _source?: string): string {
  const map = buildRenameMap(node);
  return emit(node, map);
}
