/**
 * T04 — Function extraction.
 *
 * Walk a parsed tree and emit a FunctionNode per function/method, including
 * nested functions, methods, constructors and overloads.
 *
 *   C++ : function_definition (top-level, in-class methods, nested)
 *   C#  : method_declaration, constructor_declaration, local_function_statement
 *
 * Each FunctionNode carries name, signature text, the body subtree (the
 * compound_statement / block) and its source range. `id` is left null; it is
 * filled by T06 after normalization + hashing.
 */

import type { Node, Tree } from "web-tree-sitter";
import type { AstNode, FieldInfo, FunctionNode, ParamInfo, SourceRange, TypeDecl } from "../types.js";
import { freezeBody } from "./freeze.js";

/** Node types that introduce a function-like definition, by language family. */
const FUNCTION_DEFINITION_TYPES = new Set<string>([
  // C++
  "function_definition",
  // C#
  "method_declaration",
  "constructor_declaration",
  "destructor_declaration",
  "operator_declaration",
  "local_function_statement",
  // TypeScript / TSX
  "function_declaration",
  "method_definition",
  "arrow_function",
  "function_expression",
]);

/** Body container node types (the block we normalize over). */
const BODY_TYPES = new Set<string>(["compound_statement", "block", "statement_block"]);

function toRange(node: Node, filePath: string): SourceRange {
  return {
    start: { line: node.startPosition.row, column: node.startPosition.column },
    end: { line: node.endPosition.row, column: node.endPosition.column },
    filePath,
  };
}

/** Find the body block child of a function definition node. */
function findBody(node: Node): Node | null {
  // tree-sitter exposes the body via the `body` field for both grammars.
  const byField = node.childForFieldName("body");
  if (byField && BODY_TYPES.has(byField.type)) return byField;
  // Fallback: scan direct children for a block.
  for (const child of node.namedChildren) {
    if (child && BODY_TYPES.has(child.type)) return child;
  }
  return null;
}

/**
 * Extract the declared name of a function-like node.
 *
 * C# exposes a `name` field. C++ function_definition nests the name inside the
 * declarator (function_declarator → identifier / field_identifier /
 * qualified_identifier / operator_name / destructor_name).
 * TypeScript function_declaration and method_definition expose a `name` field.
 * TypeScript arrow_function / function_expression bound to a const/let get their
 * name from the grandparent variable_declarator's `name` field.
 */
function extractName(node: Node): string {
  const nameField = node.childForFieldName("name");
  if (nameField) return nameField.text;

  // C++: descend the declarator chain to the innermost identifier-like node.
  const declarator = node.childForFieldName("declarator");
  if (declarator) {
    const id = findDeclaratorName(declarator);
    if (id) return id;
  }

  // TypeScript: arrow_function / function_expression assigned to a variable.
  // Parent is `variable_declarator`; its `name` field is the binding identifier.
  if (node.type === "arrow_function" || node.type === "function_expression") {
    const parent = node.parent;
    if (parent && parent.type === "variable_declarator") {
      const nameNode = parent.childForFieldName("name");
      if (nameNode) return nameNode.text;
    }
  }

  return "<anonymous>";
}

const NAME_NODE_TYPES = new Set<string>([
  "identifier",
  "field_identifier",
  "qualified_identifier",
  "operator_name",
  "destructor_name",
  "type_identifier",
]);

export function findDeclaratorName(node: AstNode): string | null {
  if (NAME_NODE_TYPES.has(node.type)) return node.text;
  // function_declarator / pointer_declarator / reference_declarator wrap a
  // `declarator` field pointing further inward.
  const inner = node.childForFieldName("declarator");
  if (inner) {
    const found = findDeclaratorName(inner);
    if (found) return found;
  }
  // A name node directly under this declarator (e.g. function_declarator's
  // field_identifier / qualified_identifier).
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (NAME_NODE_TYPES.has(child.type)) return child.text;
  }
  // reference_declarator (`& foo()`) and similar expose their inner declarator as
  // a POSITIONAL child, not a `declarator` field — recurse into nested declarators
  // so `const X& foo()` resolves to `foo` rather than `<anonymous>`.
  for (const child of node.namedChildren) {
    if (!child || !child.type.endsWith("_declarator")) continue;
    const found = findDeclaratorName(child);
    if (found) return found;
  }
  return null;
}

/**
 * Build the signature text: the function definition minus its body.
 * This keeps the return type + name + parameter list (public-meaning bits)
 * while excluding the body whose structure is hashed separately.
 */
function extractSignature(node: Node, body: Node | null): string {
  const full = node.text;
  if (!body) return full.trim();
  const bodyStart = body.startIndex - node.startIndex;
  return full.slice(0, bodyStart).trim();
}

// ---------------------------------------------------------------------------
// Type-name reduction (used by params, type decls, and the resolver inputs)
// ---------------------------------------------------------------------------

/** Type AST node kinds that NAME a class/struct/interface (worth resolving). */
const TYPE_NAME_NODE_TYPES = new Set<string>([
  "type_identifier", // C++ class/struct/interface name; C# unqualified type
  "identifier", // C# unqualified type
]);

/**
 * Reduce a type AST node to a simple class name, or null if it cannot name a
 * user type (primitive, `var`/`auto`, etc.).
 *
 *   const combat::HitReceiver&  → declarator strips &; this strips the namespace
 *   PlayerActor                 → PlayerActor
 *   std::vector<Foo>            → vector  (template base; rarely a known type)
 *   int / bool / var            → null
 */
export function simpleTypeName(typeNode: AstNode | null): string | null {
  if (!typeNode) return null;
  const t = typeNode.type;
  if (t === "primitive_type" || t === "predefined_type" || t === "implicit_type") {
    return null; // int/bool/void/… and C# `var`
  }
  if (TYPE_NAME_NODE_TYPES.has(t)) return typeNode.text;
  // qualified_identifier / scoped_identifier (C++): take the rightmost name.
  if (t === "qualified_identifier" || t === "scoped_identifier" || t === "scoped_type_identifier") {
    const nameField = typeNode.childForFieldName("name");
    if (nameField) return simpleTypeName(nameField);
    const named = typeNode.namedChildren;
    const last = named[named.length - 1];
    if (last) return simpleTypeName(last);
  }
  // template_type (C++) / generic_name (C#): use the base name only.
  if (t === "template_type") {
    const name =
      typeNode.childForFieldName("name") ??
      typeNode.namedChildren.find((c) => c && c.type === "type_identifier") ??
      null;
    return simpleTypeName(name);
  }
  if (t === "generic_name") {
    const id = typeNode.namedChildren.find((c) => c && c.type === "identifier");
    return id ? id.text : null;
  }
  return null;
}

/**
 * For a single-argument container template, return the simple element type:
 *   std::vector<IDamageReceiver*>  → IDamageReceiver
 *   List<Foo>  (C#)               → Foo
 * Returns null when the type is not a 1-arg template. Pointers/refs on the
 * element are stripped (the element's class name is what we resolve against).
 */
export function templateElementName(typeNode: AstNode | null): string | null {
  if (!typeNode) return null;
  // Drill to the template_type / generic_name carrying the argument list.
  let tmpl: AstNode | null = null;
  if (typeNode.type === "template_type" || typeNode.type === "generic_name") {
    tmpl = typeNode;
  } else {
    tmpl =
      typeNode.namedChildren.find(
        (c) => c && (c.type === "template_type" || c.type === "generic_name"),
      ) ?? null;
  }
  if (!tmpl) return null;
  const argList = tmpl.namedChildren.find(
    (c) => c && (c.type === "template_argument_list" || c.type === "type_argument_list"),
  );
  if (!argList) return null;
  // First type argument: C++ wraps it in type_descriptor; C# uses the type node directly.
  const firstArg = argList.namedChildren.find((c) => c !== null) ?? null;
  if (!firstArg) return null;
  if (firstArg.type === "type_descriptor") {
    const inner =
      firstArg.childForFieldName("type") ??
      firstArg.namedChildren.find(
        (c) =>
          c &&
          (c.type === "type_identifier" ||
            c.type === "qualified_identifier" ||
            c.type === "template_type"),
      ) ??
      null;
    return simpleTypeName(inner);
  }
  return simpleTypeName(firstArg);
}

// ---------------------------------------------------------------------------
// Enclosing type (the class a method belongs to)
// ---------------------------------------------------------------------------

/** Class/struct/interface container node types, by language family. */
const TYPE_CONTAINER_TYPES = new Set<string>([
  // C++
  "class_specifier",
  "struct_specifier",
  // C#
  "class_declaration",
  "struct_declaration",
  "interface_declaration",
  "record_declaration",
  "record_struct_declaration",
]);

/** Simple name of a type-container node (the class name). */
function typeContainerName(node: Node): string | null {
  const nameField = node.childForFieldName("name");
  if (nameField) return simpleTypeName(nameField) ?? nameField.text;
  // C++ class_specifier exposes the name as a `name` field OR a leading child.
  for (const child of node.namedChildren) {
    if (child && (child.type === "type_identifier" || child.type === "identifier")) {
      return child.text;
    }
  }
  return null;
}

/**
 * Determine the class a function-like node belongs to:
 *   1. an out-of-line C++ definition `void Class::method()` — read the qualifier
 *      from the declarator's qualified_identifier (works even when the class body
 *      is in another file);
 *   2. else the nearest enclosing class/struct/interface container.
 * Returns undefined for free functions.
 */
function extractEnclosingType(node: Node): string | undefined {
  const qualifier = qualifiedDefinitionScope(node);
  if (qualifier) return qualifier;
  let cur: Node | null = node.parent;
  while (cur) {
    if (TYPE_CONTAINER_TYPES.has(cur.type)) {
      const name = typeContainerName(cur);
      if (name) return name;
    }
    cur = cur.parent;
  }
  return undefined;
}

/** For `Ret Class::method(...)`, return `Class`; else null. */
function qualifiedDefinitionScope(node: Node): string | null {
  let declarator = node.childForFieldName("declarator");
  // Unwrap pointer/reference declarators around the function_declarator.
  while (declarator && declarator.type !== "function_declarator") {
    const inner = declarator.childForFieldName("declarator");
    if (!inner) break;
    declarator = inner;
  }
  if (!declarator || declarator.type !== "function_declarator") return null;
  const fnName = declarator.childForFieldName("declarator");
  if (!fnName || (fnName.type !== "qualified_identifier" && fnName.type !== "scoped_identifier")) {
    return null;
  }
  // The `::` scope is the owning class. tree-sitter-cpp tags the qualifier as
  // `namespace_identifier` (e.g. `AttackHitbox::sweep` → scope namespace_identifier
  // "AttackHitbox"), so accept that in addition to type/qualified names; a nested
  // qualifier (`A::B::method`) reduces to the innermost class B.
  const scope = fnName.childForFieldName("scope");
  if (!scope) return null;
  if (
    scope.type === "namespace_identifier" ||
    scope.type === "type_identifier" ||
    scope.type === "identifier"
  ) {
    return scope.text;
  }
  return simpleTypeName(scope);
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/** Find the parameter_list of a function-like node. */
function findParamList(node: Node): Node | null {
  // C#: parameter_list is a direct field/child of the declaration.
  const direct = node.childForFieldName("parameters");
  if (direct) return direct;
  // C++: nested inside the function_declarator.
  let declarator = node.childForFieldName("declarator");
  while (declarator) {
    if (declarator.type === "function_declarator") {
      for (const c of declarator.namedChildren) {
        if (c && c.type === "parameter_list") return c;
      }
      return null;
    }
    const inner = declarator.childForFieldName("declarator");
    if (!inner) break;
    declarator = inner;
  }
  // Fallback: scan direct children.
  for (const c of node.namedChildren) {
    if (c && c.type === "parameter_list") return c;
  }
  return null;
}

/** Extract `{name, type}` for each formal parameter. */
function extractParams(node: Node): ParamInfo[] {
  const list = findParamList(node);
  if (!list) return [];
  const out: ParamInfo[] = [];
  for (const p of list.namedChildren) {
    if (!p) continue;
    if (p.type === "parameter_declaration") {
      // C++: type field + declarator (ref/pointer/identifier).
      const typeNode = p.childForFieldName("type");
      const declarator = p.childForFieldName("declarator");
      const name = declarator ? findDeclaratorName(declarator) : null;
      if (name) out.push({ name, type: simpleTypeName(typeNode), elementType: templateElementName(typeNode) });
    } else if (p.type === "parameter") {
      // C#: type field + name field.
      const typeNode = p.childForFieldName("type");
      const nameNode = p.childForFieldName("name");
      if (nameNode) {
        out.push({ name: nameNode.text, type: simpleTypeName(typeNode), elementType: templateElementName(typeNode) });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Type declarations (class / struct / interface + bases)
// ---------------------------------------------------------------------------

/** Collect the simple base-type names from a C++ base_class_clause / C# base_list. */
function extractBases(container: Node): string[] {
  const clause =
    container.namedChildren.find(
      (c) => c && (c.type === "base_class_clause" || c.type === "base_list"),
    ) ?? null;
  if (!clause) return [];
  const bases: string[] = [];
  for (const c of clause.namedChildren) {
    if (!c) continue;
    const name = simpleTypeName(c);
    if (name) bases.push(name);
  }
  return [...new Set(bases)];
}

/** Does this field_declaration declare a method (has a function_declarator)? */
function declaresFunction(decl: Node): boolean {
  let d: Node | null = decl.childForFieldName("declarator");
  while (d) {
    if (d.type === "function_declarator") return true;
    d = d.childForFieldName("declarator");
  }
  return decl.namedChildren.some((c) => c && c.type === "function_declarator");
}

/** Name of a data-member field_declaration (field_identifier / wrapped declarator). */
function memberFieldName(decl: Node): string | null {
  const d = decl.childForFieldName("declarator");
  if (d) {
    const n = findDeclaratorName(d);
    if (n) return n;
  }
  const fi = decl.namedChildren.find(
    (c) => c && (c.type === "field_identifier" || c.type === "identifier"),
  );
  return fi ? fi.text : null;
}

/**
 * Extract a class's DIRECT data members (fields/properties) with their simple
 * type / container element type. Methods (function_definition / field_declaration
 * with a function_declarator) are skipped. Members whose type names neither a
 * class nor a container element are dropped (useless for receiver typing).
 */
function extractFields(container: Node): FieldInfo[] {
  const list = container.namedChildren.find(
    (c) => c && (c.type === "field_declaration_list" || c.type === "declaration_list"),
  );
  if (!list) return [];
  const out: FieldInfo[] = [];
  const push = (name: string | null, typeNode: Node | null): void => {
    if (!name) return;
    const type = simpleTypeName(typeNode);
    const elementType = templateElementName(typeNode);
    if (type || elementType) out.push({ name, type, elementType });
  };
  for (const m of list.namedChildren) {
    if (!m) continue;
    if (m.type === "field_declaration") {
      if (declaresFunction(m)) continue; // method declaration, not a data member
      // C# wraps the member in a variable_declaration; C++ is flat.
      const vd = m.namedChildren.find((c) => c && c.type === "variable_declaration");
      if (vd) {
        const t = vd.childForFieldName("type");
        for (const d of vd.namedChildren) {
          if (!d || d.type !== "variable_declarator") continue;
          const nn = d.childForFieldName("name") ?? d.namedChildren[0];
          if (nn && nn.type === "identifier") push(nn.text, t);
        }
      } else {
        push(memberFieldName(m), m.childForFieldName("type"));
      }
    } else if (m.type === "property_declaration") {
      // C#: `public X Y { get; }` — accessed like a field for receiver typing.
      push(m.childForFieldName("name")?.text ?? null, m.childForFieldName("type"));
    }
  }
  return out;
}

/** Extract every class/struct/interface declaration (name + bases + fields). */
export function extractTypeDecls(tree: Tree, filePath = "<memory>"): TypeDecl[] {
  const out: TypeDecl[] = [];
  const visit = (node: Node): void => {
    if (TYPE_CONTAINER_TYPES.has(node.type)) {
      const name = typeContainerName(node);
      if (name) {
        const fields = extractFields(node);
        out.push({
          name,
          bases: extractBases(node),
          filePath,
          sourceRange: toRange(node, filePath),
          ...(fields.length > 0 ? { fields } : {}),
        });
      }
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(tree.rootNode);
  return out;
}

/**
 * Recursively collect function-like nodes. Nested functions (e.g. C# local
 * functions, C++ functions defined inside others) are included.
 */
function collect(node: Node, source: string, filePath: string, out: FunctionNode[]): void {
  if (FUNCTION_DEFINITION_TYPES.has(node.type)) {
    const body = findBody(node);
    // Declaration-only nodes (no body) are skipped; we hash bodies.
    if (body) {
      const enclosingType = extractEnclosingType(node);
      const params = extractParams(node);
      // Return type (drives `auto x = recv.method()` local typing). The `type`
      // field is the declared return type for both C++ and C# definitions;
      // const/&/* live outside it, so simpleType/templateElement see the core type.
      const retNode = node.childForFieldName("type");
      const returnType = simpleTypeName(retNode);
      const returnElementType = templateElementName(retNode);
      out.push({
        id: null,
        name: extractName(node),
        signature: extractSignature(node, body),
        ...(enclosingType ? { enclosingType } : {}),
        ...(params.length > 0 ? { params } : {}),
        ...(returnType ? { returnType } : {}),
        ...(returnElementType ? { returnElementType } : {}),
        sourceRange: toRange(node, filePath),
        // Detach the body from the native tree-sitter tree immediately so the
        // caller can delete the parsed Tree per-file (bounds the WASM heap).
        bodyAst: freezeBody(body),
      });
    }
  }
  for (const child of node.namedChildren) {
    if (child) collect(child, source, filePath, out);
  }
}

/**
 * Extract every function/method (with a body) from a parsed tree.
 *
 * @param tree   parsed tree-sitter Tree
 * @param source original source text (used for ranges/signatures)
 * @param filePath absolute path recorded on each node's SourceRange
 */
export function extractFunctions(
  tree: Tree,
  source: string,
  filePath = "<memory>",
): FunctionNode[] {
  const out: FunctionNode[] = [];
  collect(tree.rootNode, source, filePath, out);
  return out;
}
