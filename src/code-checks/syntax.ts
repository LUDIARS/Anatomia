/**
 * @spec C++ code-level static checks
 *
 * src/code-checks/syntax.ts — tree-sitter-cpp traversal helpers shared by the
 * check families.
 *
 * SRP: read-only queries over a C++ syntax tree (walking, naming functions,
 * locating identifiers). No rule logic lives here.
 */

import type { Node } from "web-tree-sitter";

/** Every node under `root` (pre-order), including `root`. */
export function* walk(root: Node): Generator<Node> {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    yield node;
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }
}

/** Nodes of the given types under `root`. */
export function nodesOfType(root: Node, types: ReadonlySet<string>): Node[] {
  const found: Node[] = [];
  for (const node of walk(root)) if (types.has(node.type)) found.push(node);
  return found;
}

const FUNCTION_TYPES = new Set(["function_definition"]);
const LAMBDA_TYPE = "lambda_expression";

/** Function definitions with a body (declarations without one are skipped). */
export function functionDefinitions(root: Node): Node[] {
  return nodesOfType(root, FUNCTION_TYPES).filter((fn) => fn.childForFieldName("body") !== null);
}

/** The innermost `function_declarator` of a definition, through pointers/references. */
export function functionDeclarator(fn: Node): Node | null {
  let current = fn.childForFieldName("declarator");
  while (current && current.type !== "function_declarator") {
    current = current.childForFieldName("declarator") ?? current.namedChildren.find((c) => c !== null) ?? null;
  }
  return current;
}

/** `name`, `Class::name` or `ns::name` as written; `<anonymous>` when absent. */
export function functionName(fn: Node): string {
  const declarator = functionDeclarator(fn);
  return declarator?.childForFieldName("declarator")?.text ?? "<anonymous>";
}

/** Parameter declarations of a definition (variadic `...` excluded). */
export function parameters(fn: Node): Node[] {
  const list = functionDeclarator(fn)?.childForFieldName("parameters");
  if (!list) return [];
  return list.namedChildren.filter(
    (p): p is Node => p !== null && (p.type === "parameter_declaration" || p.type === "optional_parameter_declaration"),
  );
}

/**
 * The declared identifier inside a declarator, unwrapping pointer, reference,
 * array and init declarators. Null for abstract declarators.
 */
export function declaredIdentifier(declarator: Node | null): Node | null {
  let current = declarator;
  while (current) {
    if (current.type === "identifier" || current.type === "field_identifier") return current;
    const inner = current.childForFieldName("declarator");
    if (inner) {
      current = inner;
      continue;
    }
    current = current.namedChildren.find((c) => c?.type === "identifier") ?? null;
  }
  return null;
}

/** True when `node` sits inside a lambda nested in `fn` (its own scope). */
export function insideNestedLambda(node: Node, fn: Node): boolean {
  let current = node.parent;
  while (current && current.id !== fn.id) {
    if (current.type === LAMBDA_TYPE) return true;
    current = current.parent;
  }
  return false;
}

/** Identifier nodes naming `name` under `scope`, in source order. */
export function identifierUses(scope: Node, name: string): Node[] {
  const uses: Node[] = [];
  for (const node of walk(scope)) if (node.type === "identifier" && node.text === name) uses.push(node);
  return uses.sort((a, b) => a.startIndex - b.startIndex);
}

/** 1-based position of a node. */
export function position(node: Node): { line: number; column: number } {
  return { line: node.startPosition.row + 1, column: node.startPosition.column + 1 };
}

/** The nearest ancestor (or self) whose type is in `types`. */
export function closest(node: Node, types: ReadonlySet<string>): Node | null {
  let current: Node | null = node;
  while (current) {
    if (types.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

/** The function definition enclosing `node`, if any. */
export function enclosingFunction(node: Node): Node | null {
  return closest(node, FUNCTION_TYPES);
}

/** True when `ancestor` contains `node` (inclusive). */
export function contains(ancestor: Node, node: Node): boolean {
  return node.startIndex >= ancestor.startIndex && node.endIndex <= ancestor.endIndex;
}
