/**
 * @spec C++ code-level static checks
 *
 * src/code-checks/locals.ts — the local variables a C++ function body declares.
 *
 * Memory (dangling returns), placement (declaration distance / scope) and
 * declaration (initialisation / const) rules all ask the same question — which
 * names does this body declare, where, and how — so it is answered once here.
 *
 * SRP: extracting local declarations from a function body.
 */

import type { Node } from "web-tree-sitter";
import { declaredIdentifier, identifierUses, insideNestedLambda, walk } from "./syntax.js";

export interface LocalVariable {
  readonly name: string;
  /** The identifier node in the declarator. */
  readonly identifier: Node;
  /** The whole `declaration` statement. */
  readonly declaration: Node;
  /** The block (`compound_statement`, `for` initializer owner...) that scopes it. */
  readonly scope: Node;
  /** Type text as written (`int`, `auto`, `std::vector<int>`). */
  readonly typeText: string;
  readonly isStatic: boolean;
  readonly isConst: boolean;
  /** Declared as `T&` / `T&&` — it refers to storage it does not own. */
  readonly isReference: boolean;
  readonly isPointer: boolean;
  readonly isArray: boolean;
  /** Has an initializer (`= x`, `{x}`, `(x)`). */
  readonly isInitialized: boolean;
  /** How many names the same declaration statement introduces. */
  readonly siblings: number;
}

const SCOPE_TYPES = new Set(["compound_statement", "for_statement", "for_range_loop", "if_statement", "while_statement", "switch_statement"]);

function scopeOf(declaration: Node): Node {
  let current = declaration.parent;
  while (current && !SCOPE_TYPES.has(current.type)) current = current.parent;
  return current ?? declaration;
}

function hasSpecifier(declaration: Node, type: string, text: string): boolean {
  return declaration.namedChildren.some((child) => child?.type === type && child.text === text);
}

function declaratorShape(declaration: Node, declarator: Node): { isReference: boolean; isPointer: boolean; isArray: boolean; isInitialized: boolean } {
  // A condition declaration (`if (T* p = f())`) carries its initializer as the
  // declaration's `value` field rather than through an init_declarator.
  const shape = { isReference: false, isPointer: false, isArray: false, isInitialized: declaration.childForFieldName("value") !== null };
  let current: Node | null = declarator;
  while (current) {
    if (current.type === "init_declarator") shape.isInitialized = true;
    if (current.type === "reference_declarator") shape.isReference = true;
    if (current.type === "pointer_declarator") shape.isPointer = true;
    if (current.type === "array_declarator") shape.isArray = true;
    current = current.childForFieldName("declarator") ?? current.namedChildren.find((c) => c?.type === "identifier" || c?.type.endsWith("_declarator")) ?? null;
    if (current?.type === "identifier") break;
  }
  return shape;
}

/**
 * The local an identifier use refers to: the innermost declaration of that name
 * whose scope contains the use and which is declared before it. Null when the
 * name is not a local (a parameter, member or global).
 */
export function resolveLocal(locals: readonly LocalVariable[], use: Node): LocalVariable | null {
  let best: LocalVariable | null = null;
  for (const local of locals) {
    if (local.name !== use.text) continue;
    if (use.startIndex < local.identifier.startIndex) continue;
    if (use.startIndex < local.scope.startIndex || use.endIndex > local.scope.endIndex) continue;
    if (!best || local.scope.startIndex >= best.scope.startIndex) best = local;
  }
  return best;
}

/** Uses of `local` after its declaration, excluding same-named locals that shadow it. */
export function usesOf(local: LocalVariable, locals: readonly LocalVariable[]): Node[] {
  return identifierUses(local.scope, local.name).filter(
    (use) => use.startIndex >= local.declaration.endIndex && resolveLocal(locals, use) === local,
  );
}

/** Local variables declared directly in `fn`'s body (nested lambdas excluded). */
export function localVariables(fn: Node): LocalVariable[] {
  const body = fn.childForFieldName("body");
  if (!body) return [];
  const locals: LocalVariable[] = [];
  for (const node of walk(body)) {
    if (node.type !== "declaration" || insideNestedLambda(node, fn)) continue;
    const typeNode = node.childForFieldName("type");
    const declarators = node.childrenForFieldName("declarator").filter((d): d is Node => d !== null);
    for (const declarator of declarators) {
      const identifier = declaredIdentifier(declarator);
      // A function prototype inside a body (`int f(int);`) declares no variable.
      if (!identifier || declarator.type === "function_declarator") continue;
      locals.push({
        name: identifier.text,
        identifier,
        declaration: node,
        scope: scopeOf(node),
        typeText: typeNode?.text ?? "",
        isStatic: hasSpecifier(node, "storage_class_specifier", "static"),
        isConst: hasSpecifier(node, "type_qualifier", "const") || hasSpecifier(node, "type_qualifier", "constexpr"),
        ...declaratorShape(node, declarator),
        siblings: declarators.length,
      });
    }
  }
  return locals;
}
