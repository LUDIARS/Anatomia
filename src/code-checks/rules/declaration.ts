/**
 * @spec C++ code-level static checks
 *
 * src/code-checks/rules/declaration.ts — whether locals are declared well.
 *
 * References: C++ Core Guidelines ES.20 (always initialize), ES.10 (one
 * declaration per statement), Con.4 (const for values that do not change);
 * clang-tidy cppcoreguidelines-init-variables, readability-isolate-declaration,
 * misc-const-correctness; compiler -Wunused-variable.
 *
 * Only built-in scalar types are judged for "uninitialized" and "unused":
 * a class type runs its constructor (and an "unused" `std::lock_guard` is the
 * whole point), so the syntax alone cannot call those wrong.
 *
 * SRP: declaration-quality findings for the locals of each function in one file.
 */

import type { Node } from "web-tree-sitter";
import { localVariables, usesOf, type LocalVariable } from "../locals.js";
import { functionDefinitions, functionName, insideNestedLambda, position } from "../syntax.js";
import type { CheckFamily, CheckedSource, RawFinding } from "../types.js";

const SCALAR = /^(?:(?:un)?signed\s+)?(?:bool|char|char8_t|char16_t|char32_t|wchar_t|short|int|long|long\s+long|float|double|long\s+double|unsigned|signed|(?:std::)?(?:size_t|ptrdiff_t|intptr_t|uintptr_t|u?int(?:8|16|32|64)_t))$/;
/** Wrappers a write can reach the variable through: `x[i] = …`, `x.f = …`, `(x) = …`, `*x = …`. */
const LVALUE_PATH = new Set(["subscript_expression", "field_expression", "parenthesized_expression", "pointer_expression"]);

function isScalar(local: LocalVariable): boolean {
  return SCALAR.test(local.typeText.replace(/\s+/g, " ").trim());
}

function finding(rule: string, local: LocalVariable, message: string, symbol: string): RawFinding {
  return { rule, category: "declaration", ...position(local.identifier), message, symbol };
}

/** True when this use may modify the variable (or hands it to code that might). */
function mayWrite(use: Node, fn: Node): boolean {
  if (insideNestedLambda(use, fn)) return true;
  let child: Node = use;
  let parent = use.parent;
  while (parent && LVALUE_PATH.has(parent.type)) {
    // `&x` hands out a mutable pointer; `x.f(...)` may call a non-const member.
    if (parent.type === "pointer_expression" && parent.child(0)?.text === "&") return true;
    if (parent.type === "field_expression" && parent.parent?.type === "call_expression") return true;
    child = parent;
    parent = parent.parent;
  }
  if (!parent) return false;
  if (parent.type === "assignment_expression" && parent.childForFieldName("left")?.id === child.id) return true;
  if (parent.type === "update_expression") return true;
  // Passing by name may bind to a non-const reference parameter.
  if (parent.type === "argument_list") return true;
  // `in >> x` extracts into x.
  if (parent.type === "binary_expression" && parent.childForFieldName("operator")?.text === ">>" && parent.childForFieldName("right")?.id === child.id) return true;
  // Range-for over x by non-const reference may modify its elements.
  if (parent.type === "for_range_loop") return true;
  return false;
}

function check(fn: Node): RawFinding[] {
  const out: RawFinding[] = [];
  const symbol = functionName(fn);
  const reportedStatements = new Set<number>();
  const locals = localVariables(fn);
  for (const local of locals) {
    const uses = usesOf(local, locals);
    // Arrays are left out as clang-tidy cppcoreguidelines-init-variables does:
    // a fixed buffer filled by the next call is the idiomatic use.
    const scalar = (isScalar(local) || local.isPointer) && !local.isArray;

    if (!local.isInitialized && !local.isStatic && scalar) {
      out.push(finding("declaration/uninitialized", local, `\`${local.name}\` is declared without an initial value`, symbol));
    }
    if (local.siblings > 1 && !reportedStatements.has(local.declaration.id)) {
      reportedStatements.add(local.declaration.id);
      out.push(finding("declaration/multiple-per-statement", local, `${local.siblings} variables in one declaration; declare one per statement`, symbol));
    }
    if (uses.length === 0 && isScalar(local)) {
      out.push(finding("declaration/unused", local, `\`${local.name}\` is never used`, symbol));
      continue;
    }
    const constCandidate =
      local.isInitialized && !local.isConst && !local.isStatic && !local.isReference && !local.isPointer && !local.isArray;
    if (constCandidate && uses.length > 0 && !uses.some((use) => mayWrite(use, fn))) {
      out.push(finding("declaration/const-candidate", local, `\`${local.name}\` is never modified; declare it const`, symbol));
    }
  }
  return out;
}

export const declarationFamily: CheckFamily = {
  category: "declaration",
  rules: {
    "declaration/uninitialized": "warning",
    "declaration/multiple-per-statement": "info",
    "declaration/unused": "warning",
    "declaration/const-candidate": "info",
  },
  check(source: CheckedSource) {
    return functionDefinitions(source.root).flatMap(check);
  },
};
