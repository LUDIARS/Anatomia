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

import type { AstNode } from "../types.js";

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
  // TypeScript: `const x = ...` / `let x = ...` / `var x = ...`
  // The outer node is `lexical_declaration`; the inner binders are
  // `variable_declarator` nodes (shared with C# but same semantics here).
  "lexical_declaration",
]);

interface RenameMap {
  /** original local-variable name -> $vN */
  vars: Map<string, string>;
  /** original parameter name -> $pN */
  params: Map<string, string>;
}

/** Walk a parameter list and collect parameter names in order. */
function collectParamNames(funcNode: AstNode, params: Map<string, string>): void {
  // C++/C#: field name "parameters" → parameter_list / parameter_declaration
  // TypeScript: field name "parameters" → formal_parameters / required_parameter / optional_parameter
  const paramList =
    funcNode.childForFieldName("parameters") ??
    funcNode.descendantsOfType("parameter_list")[0] ??
    funcNode.descendantsOfType("formal_parameters")[0] ??
    null;
  if (!paramList) return;
  for (const p of paramList.namedChildren) {
    if (!p) continue;
    // TypeScript: required_parameter / optional_parameter have a `pattern` field
    // (the binding identifier) or a plain `identifier` child.
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
function findBoundIdentifier(node: AstNode): string | null {
  // C# parameter / variable_declarator expose `name`.
  const nameField = node.childForFieldName("name");
  if (nameField && nameField.type === "identifier") return nameField.text;

  // TypeScript: required_parameter / optional_parameter expose a `pattern` field
  // (which is an `identifier` for simple params).
  const patternField = node.childForFieldName("pattern");
  if (patternField && patternField.type === "identifier") return patternField.text;

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
function collectLocalNames(node: AstNode, vars: Map<string, string>): void {
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
    } else if (node.type === "lexical_declaration") {
      // TypeScript: `const x = ...` / `let x = ...` — children are variable_declarator nodes.
      for (const child of node.namedChildren) {
        if (!child || child.type !== "variable_declarator") continue;
        const name = findBoundIdentifier(child);
        if (name && !vars.has(name)) vars.set(name, "$v" + vars.size);
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
function buildRenameMap(body: AstNode): RenameMap {
  const vars = new Map<string, string>();
  const params = new Map<string, string>();
  const fn = body.parent;
  if (fn) collectParamNames(fn, params);
  collectLocalNames(body, vars);
  return { vars, params };
}

/** Render a leaf identifier, applying alpha-rename if it is a known local/param. */
function renderIdentifier(node: AstNode, map: RenameMap): string {
  const t = node.text;
  const v = map.vars.get(t);
  if (v) return "(id " + v + ")";
  const p = map.params.get(t);
  if (p) return "(id " + p + ")";
  // Kept verbatim (call name, free symbol, type used as value, etc.).
  return "(id " + t + ")";
}

/** Recursively emit a canonical S-expression for `node`. */
function emit(node: AstNode, map: RenameMap): string {
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
export function normalize(node: AstNode, _source?: string): string {
  const map = buildRenameMap(node);
  return emit(node, map);
}

/**
 * Normalize the *signature shape* of the function that owns `bodyNode`.
 *
 * Returns a canonical string encoding the return type and each parameter's
 * *type* (not name) so that:
 *   - parameter *renames*  (int a → int b)  → SAME string (names ignored)
 *   - parameter *type* changes (int → float) → DIFFERENT string
 *   - return-type changes                    → DIFFERENT string
 *
 * Types are kept verbatim (public symbols), only collapsing internal
 * whitespace. Falls back to "(sig)" if the AST offers no type info
 * (e.g. no parent node), ensuring graceful degradation.
 *
 * The result is NOT a complete type system; it is a best-effort canonical
 * shape string derived directly from tree-sitter text fields.
 */
export function normalizeSignatureShape(bodyNode: AstNode): string {
  const fn = bodyNode.parent;
  if (!fn) return "(sig)";

  const scope = enclosingScope(fn);
  const fnName = functionName(fn);

  // ── Return type ────────────────────────────────────────────────────────────
  // C++/C#: `type` field. TypeScript uses a `type_annotation` node (`: T`)
  // or `return_type` field in some grammar versions. We try both.
  const retNode =
    fn.childForFieldName("return_type") ??
    fn.childForFieldName("type") ??
    fn.childForFieldName("type_annotation") ??
    null;
  const retText = retNode ? retNode.text.replace(/:\s*/, "").replace(/\s+/g, " ").trim() : "";

  // ── Parameter list ─────────────────────────────────────────────────────────
  // C++/C#: field name "parameters" → parameter_list / parameter_declaration.
  // TypeScript: field name "parameters" → formal_parameters / required_parameter /
  //   optional_parameter. Type annotation sits in a `type` field (`: T`).
  const paramList =
    fn.childForFieldName("parameters") ??
    fn.descendantsOfType("parameter_list")[0] ??
    fn.descendantsOfType("formal_parameters")[0] ??
    null;

  const paramTypes: string[] = [];
  if (paramList) {
    for (const p of paramList.namedChildren) {
      if (!p) continue;
      // C++: parameter_declaration has a `type` field.
      // C#:  parameter has a `type` field too.
      // TypeScript required_parameter / optional_parameter: `type` field is the
      //   type annotation node (text includes leading `:` in some grammar versions).
      const typeField = p.childForFieldName("type");
      if (typeField) {
        // Strip the leading `: ` in TypeScript type annotations if present.
        paramTypes.push(typeField.text.replace(/^:\s*/, "").replace(/\s+/g, " ").trim());
      } else if (p.type === "variadic_parameter") {
        // Keep the full node text for variadic params (no name).
        paramTypes.push(p.text.replace(/\s+/g, " ").trim());
      } else if (p.type === "optional_parameter") {
        // C++ optional_parameter (variadic-style) — no type field, use node text.
        paramTypes.push(p.text.replace(/\s+/g, " ").trim());
      }
      // Nodes with no type field (e.g. `this` pseudo-param in C#, or comment
      // extras, or TS untyped params) are simply skipped — they carry no type
      // information relevant to the signature shape.
    }
  }

  const parts = paramTypes.map((t) => "(param " + t + ")").join(" ");
  return (
    "(sig (scope " +
    scope +
    ") (name " +
    fnName +
    ") (ret " +
    retText +
    ")" +
    (parts ? " " + parts : "") +
    ")"
  );
}

const TYPE_SCOPE_NODE_TYPES = new Set<string>([
  "class_specifier",
  "struct_specifier",
  "class_declaration",
  "struct_declaration",
  "interface_declaration",
  "namespace_definition",
  // TypeScript
  "class",
  "interface_body",
]);

function enclosingScope(fn: AstNode): string {
  const names: string[] = [];
  let current = fn.parent;
  while (current) {
    if (TYPE_SCOPE_NODE_TYPES.has(current.type)) {
      const name = current.childForFieldName("name");
      if (name) names.push(name.text.replace(/\s+/g, " ").trim());
    }
    current = current.parent;
  }
  return names.reverse().join("::");
}

function functionName(fn: AstNode): string {
  const name = fn.childForFieldName("name");
  if (name) return name.text.replace(/\s+/g, " ").trim();

  const declarator = fn.childForFieldName("declarator");
  const fromDeclarator = declarator ? declaratorName(declarator) : null;
  return fromDeclarator ?? "";
}

function declaratorName(node: AstNode): string | null {
  if (
    node.type === "identifier" ||
    node.type === "field_identifier" ||
    node.type === "qualified_identifier" ||
    node.type === "operator_name" ||
    node.type === "destructor_name"
  ) {
    return node.text.replace(/\s+/g, " ").trim();
  }

  const inner = node.childForFieldName("declarator");
  if (inner) {
    const found = declaratorName(inner);
    if (found) return found;
  }

  for (const child of node.namedChildren) {
    if (!child) continue;
    const found = declaratorName(child);
    if (found) return found;
  }
  return null;
}
