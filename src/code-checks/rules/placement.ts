/**
 * @spec C++ code-level static checks
 *
 * src/code-checks/rules/placement.ts — declarations placed far from where they
 * are needed (the "relocation" family).
 *
 * References: C++ Core Guidelines ES.5 (keep scopes small) / ES.21 (don't
 * introduce a name before it is needed), cppcheck `variableScope`.
 *
 * SRP: placement findings for the locals of each function in one file.
 */

import type { Node } from "web-tree-sitter";
import { localVariables, usesOf, type LocalVariable } from "../locals.js";
import { contains, functionDefinitions, functionName, insideNestedLambda, position } from "../syntax.js";
import type { CheckFamily, CheckedSource, CodeCheckThresholds, RawFinding } from "../types.js";

const LOOP_TYPES = new Set(["for_statement", "for_range_loop", "while_statement", "do_statement"]);

function usesAfterDeclaration(local: LocalVariable, locals: readonly LocalVariable[], fn: Node): Node[] {
  return usesOf(local, locals).filter((use) => !insideNestedLambda(use, fn));
}

function distance(local: LocalVariable, uses: Node[], t: CodeCheckThresholds, symbol: string): RawFinding[] {
  const first = uses[0];
  if (!first) return [];
  const gap = first.startPosition.row - local.declaration.endPosition.row;
  if (gap <= t.declarationDistance) return [];
  return [
    {
      rule: "placement/declaration-distance",
      category: "placement",
      ...position(local.identifier),
      message: `\`${local.name}\` is declared ${gap} lines before its first use; declare it where it is needed`,
      symbol,
      value: gap,
      threshold: t.declarationDistance,
    },
  ];
}

/** The direct child block of `scope` that holds `node`, when that child is a plain block or if-arm. */
function childBlock(scope: Node, node: Node): Node | null {
  let current: Node | null = node;
  let candidate: Node | null = null;
  while (current && current.id !== scope.id) {
    if (current.type === "compound_statement") candidate = current;
    if (current.parent?.id === scope.id) break;
    current = current.parent;
  }
  if (!candidate) return null;
  // Moving a declaration into a loop body would re-run it every iteration.
  let up = candidate.parent;
  while (up && up.id !== scope.id) {
    if (LOOP_TYPES.has(up.type)) return null;
    up = up.parent;
  }
  return candidate;
}

function narrowScope(local: LocalVariable, uses: Node[], symbol: string): RawFinding[] {
  if (uses.length === 0 || local.isStatic || local.scope.type !== "compound_statement") return [];
  const block = childBlock(local.scope, uses[0]!);
  if (!block || !uses.every((use) => contains(block, use))) return [];
  return [
    {
      rule: "placement/narrow-scope",
      category: "placement",
      ...position(local.identifier),
      message: `\`${local.name}\` is only used inside the block at line ${block.startPosition.row + 1}; declare it there`,
      symbol,
    },
  ];
}

export const placementFamily: CheckFamily = {
  category: "placement",
  rules: {
    "placement/declaration-distance": "warning",
    "placement/narrow-scope": "info",
  },
  check(source: CheckedSource, thresholds) {
    const out: RawFinding[] = [];
    for (const fn of functionDefinitions(source.root)) {
      const symbol = functionName(fn);
      const locals = localVariables(fn);
      for (const local of locals) {
        const uses = usesAfterDeclaration(local, locals, fn);
        out.push(...distance(local, uses, thresholds, symbol), ...narrowScope(local, uses, symbol));
      }
    }
    return out;
  },
};
