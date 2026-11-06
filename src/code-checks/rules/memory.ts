/**
 * @spec C++ code-level static checks
 *
 * src/code-checks/rules/memory.ts — memory rules modelled on Rust's ownership.
 *
 * Safe Rust has no manual allocation, no use of a moved-from value, no
 * reference outliving its owner and no unchecked reinterpretation. Each rule
 * flags the C++ construct that breaks one of those guarantees (C++ Core
 * Guidelines R.11 / C.149 / ES.56 / F.43 / Type.1, clang-tidy
 * cppcoreguidelines-owning-memory, bugprone-use-after-move).
 *
 * The tree is syntactic: use-after-move follows source order within one
 * function and treats reassignment or `clear()/reset()/assign()` as
 * re-initialisation. Paths the syntax cannot order (loops, gotos) are the known
 * limit recorded in the specification.
 *
 * SRP: ownership/lifetime findings for one parsed file.
 */

import type { Node } from "web-tree-sitter";
import { localVariables, resolveLocal } from "../locals.js";
import {
  functionDefinitions,
  functionName,
  identifierUses,
  insideNestedLambda,
  nodesOfType,
  parameters,
  position,
  declaredIdentifier,
} from "../syntax.js";
import type { CheckFamily, CheckedSource, RawFinding } from "../types.js";

const C_ALLOCATORS = new Set(["malloc", "calloc", "realloc", "free", "strdup", "aligned_alloc"]);
const UNSAFE_CASTS = new Set(["reinterpret_cast", "const_cast"]);
const REINIT_METHODS = new Set(["clear", "reset", "assign", "emplace", "swap"]);

function finding(rule: string, node: Node, message: string, symbol?: string): RawFinding {
  return { rule, category: "memory", ...position(node), message, ...(symbol ? { symbol } : {}) };
}

function symbolAt(node: Node): string | undefined {
  let current = node.parent;
  while (current && current.type !== "function_definition") current = current.parent;
  return current ? functionName(current) : undefined;
}

/** `name` / `std::name` / `::name` called as a function. */
function calleeName(call: Node): string | null {
  const callee = call.childForFieldName("function");
  if (!callee) return null;
  if (callee.type === "identifier") return callee.text;
  if (callee.type === "qualified_identifier") return callee.childForFieldName("name")?.text ?? null;
  if (callee.type === "template_function") return callee.childForFieldName("name")?.text ?? null;
  return null;
}

function rawAllocation(source: CheckedSource): RawFinding[] {
  const out: RawFinding[] = [];
  for (const node of nodesOfType(source.root, new Set(["new_expression", "delete_expression"]))) {
    if (node.type === "new_expression") {
      // Placement new constructs into storage someone else owns; it allocates nothing.
      if (node.childForFieldName("placement")) continue;
      out.push(finding("memory/raw-new", node, "`new` hands out an owning raw pointer; use std::make_unique / std::make_shared or a container", symbolAt(node)));
    } else {
      out.push(finding("memory/raw-delete", node, "manual `delete` frees memory outside RAII; let a smart pointer or container own it", symbolAt(node)));
    }
  }
  for (const call of nodesOfType(source.root, new Set(["call_expression"]))) {
    const name = calleeName(call);
    if (name && C_ALLOCATORS.has(name)) {
      out.push(finding("memory/c-allocation", call, `\`${name}\` manages memory by hand; use a container or smart pointer`, symbolAt(call)));
    }
  }
  return out;
}

function unsafeCasts(source: CheckedSource): RawFinding[] {
  const out: RawFinding[] = [];
  for (const call of nodesOfType(source.root, new Set(["call_expression"]))) {
    const name = calleeName(call);
    if (name && UNSAFE_CASTS.has(name)) {
      out.push(finding("memory/unsafe-cast", call, `\`${name}\` bypasses the type system (Rust would require \`unsafe\`)`, symbolAt(call)));
    }
  }
  for (const cast of nodesOfType(source.root, new Set(["cast_expression"]))) {
    const type = cast.childForFieldName("type");
    if (type && /\*/.test(type.text)) {
      out.push(finding("memory/unsafe-cast", cast, "C-style cast to a pointer type reinterprets memory unchecked", symbolAt(cast)));
    }
  }
  return out;
}

/** `std::move(x)` argument when it is a plain name. */
function movedName(call: Node): Node | null {
  const callee = call.childForFieldName("function");
  if (!callee || callee.type !== "qualified_identifier") return null;
  if (callee.childForFieldName("scope")?.text !== "std" || callee.childForFieldName("name")?.text !== "move") return null;
  const args = call.childForFieldName("arguments")?.namedChildren ?? [];
  return args.length === 1 && args[0]?.type === "identifier" ? args[0] : null;
}

/** Writing to the name (or resetting it) makes it valid again. */
function reinitialises(use: Node): boolean {
  const parent = use.parent;
  if (!parent) return false;
  if (parent.type === "assignment_expression" && parent.childForFieldName("left")?.id === use.id) return true;
  if (parent.type === "field_expression" && parent.childForFieldName("argument")?.id === use.id) {
    const field = parent.childForFieldName("field")?.text ?? "";
    return REINIT_METHODS.has(field) && parent.parent?.type === "call_expression";
  }
  return false;
}

/** True when `a` and `b` sit in mutually exclusive arms of one `if`. */
function exclusiveBranches(a: Node, b: Node): boolean {
  let current = a.parent;
  while (current) {
    if (current.type === "if_statement") {
      const consequence = current.childForFieldName("consequence");
      const alternative = current.childForFieldName("alternative");
      const inArm = (arm: Node | null, n: Node) => arm !== null && n.startIndex >= arm.startIndex && n.endIndex <= arm.endIndex;
      if ((inArm(consequence, a) && inArm(alternative, b)) || (inArm(alternative, a) && inArm(consequence, b))) return true;
    }
    current = current.parent;
  }
  return false;
}

const JUMPS = new Set(["return_statement", "throw_statement", "break_statement", "continue_statement", "goto_statement"]);

/**
 * True when the block holding the move leaves it after the move
 * (`out = std::move(s); return true;`): source order no longer equals
 * execution order past that point, so later text is not "after the move".
 */
function leavesBlockAfter(call: Node): boolean {
  let statement: Node | null = call;
  while (statement && statement.parent?.type !== "compound_statement") statement = statement.parent;
  if (!statement) return false;
  for (let next = statement.nextNamedSibling; next; next = next.nextNamedSibling) {
    if (JUMPS.has(next.type)) return true;
  }
  return false;
}

function useAfterMove(source: CheckedSource): RawFinding[] {
  const out: RawFinding[] = [];
  for (const fn of functionDefinitions(source.root)) {
    const body = fn.childForFieldName("body")!;
    const name = functionName(fn);
    const locals = localVariables(fn);
    for (const call of nodesOfType(body, new Set(["call_expression"]))) {
      if (insideNestedLambda(call, fn)) continue;
      const moved = movedName(call);
      if (!moved || leavesBlockAfter(call)) continue;
      const binding = resolveLocal(locals, moved);
      const later = identifierUses(body, moved.text).filter(
        (use) => use.startIndex >= call.endIndex && !insideNestedLambda(use, fn) && resolveLocal(locals, use) === binding,
      );
      for (const use of later) {
        if (exclusiveBranches(call, use)) continue;
        if (reinitialises(use)) break;
        out.push(finding("memory/use-after-move", use, `\`${moved.text}\` is used after std::move (line ${call.startPosition.row + 1}); a moved-from value has no owner`, name));
        break;
      }
    }
  }
  return out;
}

/** `&` / `*` the function's return type is declared with, if any. */
function returnIndirection(fn: Node): "pointer" | "reference" | null {
  const declarator = fn.childForFieldName("declarator");
  if (declarator?.type === "pointer_declarator") return "pointer";
  if (declarator?.type === "reference_declarator") return "reference";
  return null;
}

function danglingReturns(source: CheckedSource): RawFinding[] {
  const out: RawFinding[] = [];
  for (const fn of functionDefinitions(source.root)) {
    const kind = returnIndirection(fn);
    if (!kind) continue;
    const owned = new Set(
      localVariables(fn).filter((local) => !local.isStatic && !local.isReference && !local.isPointer).map((local) => local.name),
    );
    // By-value parameters die with the frame exactly like locals.
    for (const param of parameters(fn)) {
      const declarator = param.childForFieldName("declarator");
      const id = declaredIdentifier(declarator);
      if (id && declarator?.type === "identifier") owned.add(id.text);
    }
    for (const ret of nodesOfType(fn.childForFieldName("body")!, new Set(["return_statement"]))) {
      if (insideNestedLambda(ret, fn)) continue;
      const value = ret.namedChildren[0];
      if (!value) continue;
      const target =
        kind === "pointer" && value.type === "pointer_expression" && value.child(0)?.text === "&"
          ? value.childForFieldName("argument")
          : kind === "reference" && value.type === "identifier"
            ? value
            : null;
      if (target?.type === "identifier" && owned.has(target.text)) {
        out.push(finding("memory/dangling-return", ret, `returns a ${kind} to \`${target.text}\`, which is destroyed when the function returns`, functionName(fn)));
      }
    }
  }
  return out;
}

export const memoryFamily: CheckFamily = {
  category: "memory",
  rules: {
    "memory/raw-new": "error",
    "memory/raw-delete": "error",
    "memory/c-allocation": "error",
    "memory/use-after-move": "error",
    "memory/dangling-return": "error",
    "memory/unsafe-cast": "warning",
  },
  check(source) {
    return [...rawAllocation(source), ...unsafeCasts(source), ...useAfterMove(source), ...danglingReturns(source)];
  },
};
