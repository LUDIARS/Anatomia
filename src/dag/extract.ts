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
import type { FunctionNode, SourceRange } from "../types.js";

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

function findDeclaratorName(node: Node): string | null {
  if (NAME_NODE_TYPES.has(node.type)) return node.text;
  // function_declarator / pointer_declarator / reference_declarator wrap a
  // `declarator` field pointing further inward.
  const inner = node.childForFieldName("declarator");
  if (inner) {
    const found = findDeclaratorName(inner);
    if (found) return found;
  }
  // qualified_identifier inside function_declarator may sit as a named child.
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (NAME_NODE_TYPES.has(child.type)) return child.text;
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

/**
 * Recursively collect function-like nodes. Nested functions (e.g. C# local
 * functions, C++ functions defined inside others) are included.
 */
function collect(node: Node, source: string, filePath: string, out: FunctionNode[]): void {
  if (FUNCTION_DEFINITION_TYPES.has(node.type)) {
    const body = findBody(node);
    // Declaration-only nodes (no body) are skipped; we hash bodies.
    if (body) {
      out.push({
        id: null,
        name: extractName(node),
        signature: extractSignature(node, body),
        sourceRange: toRange(node, filePath),
        bodyAst: body,
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
