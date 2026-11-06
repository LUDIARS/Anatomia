/**
 * @spec C++ code-level static checks
 *
 * src/code-checks/cognitive-complexity.ts — how hard a C++ function is for a
 * human to follow.
 *
 * Cognitive Complexity follows G. Ann Campbell, "Cognitive Complexity — a new
 * way of measuring understandability" (SonarSource, 2017–2023):
 *   B1 increments: if / else if / else, ?:, switch, for, range-for, while, do,
 *      catch, goto, each run of like logical operators, recursion.
 *   B2 nesting: if, ?:, switch, loops and catch nest; so do lambdas.
 *   B3 nesting increments: if, ?:, switch, loops and catch add the current nesting.
 * Cyclomatic complexity is McCabe's count as lizard reports it for C++:
 * 1 + decision points (if, loops, case, catch, ?:, && / ||).
 *
 * SRP: the two complexity measures for one function definition.
 */

import type { Node } from "web-tree-sitter";
import { functionName, walk } from "./syntax.js";

const LOOPS = new Set(["for_statement", "for_range_loop", "while_statement", "do_statement"]);
const NESTING_STRUCTURES = new Set([...LOOPS, "switch_statement", "catch_clause", "conditional_expression"]);
const LOGICAL: Readonly<Record<string, "and" | "or">> = { "&&": "and", and: "and", "||": "or", or: "or" };

function logicalOperator(node: Node): "and" | "or" | null {
  if (node.type !== "binary_expression") return null;
  return LOGICAL[node.childForFieldName("operator")?.text ?? ""] ?? null;
}

/** Operators of one logical chain in source order (`a && b || c` -> and, or). */
function chainOperators(node: Node): ("and" | "or")[] {
  const op = logicalOperator(node);
  if (!op) return [];
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  return [...(left ? chainOperators(left) : []), op, ...(right ? chainOperators(right) : [])];
}

/** +1 for the first operator of a chain and for every change of operator. */
function logicalIncrement(node: Node): number {
  const ops = chainOperators(node);
  let total = 0;
  ops.forEach((op, index) => {
    if (index === 0 || ops[index - 1] !== op) total += 1;
  });
  return total;
}

function calleeText(call: Node): string {
  return call.childForFieldName("function")?.text ?? "";
}

/** Cognitive complexity of one `function_definition`. */
export function cognitiveComplexity(fn: Node): number {
  const self = functionName(fn);
  const shortSelf = self.split("::").pop() ?? self;
  let total = 0;

  const visitChildren = (node: Node, nesting: number): void => {
    for (const child of node.namedChildren) if (child) visit(child, nesting);
  };

  const visitIf = (node: Node, nesting: number, isElseIf: boolean): void => {
    total += isElseIf ? 1 : 1 + nesting;
    const condition = node.childForFieldName("condition");
    if (condition) visit(condition, nesting);
    const consequence = node.childForFieldName("consequence");
    if (consequence) visit(consequence, nesting + 1);
    const alternative = node.childForFieldName("alternative");
    if (!alternative) return;
    const inner = alternative.namedChildren.find((c) => c !== null) ?? null;
    if (inner?.type === "if_statement") {
      visitIf(inner, nesting, true);
      return;
    }
    total += 1;
    visitChildren(alternative, nesting + 1);
  };

  const visit = (node: Node, nesting: number): void => {
    if (node.type === "if_statement") return visitIf(node, nesting, false);
    if (NESTING_STRUCTURES.has(node.type)) {
      total += 1 + nesting;
      return visitChildren(node, nesting + 1);
    }
    if (node.type === "lambda_expression") return visitChildren(node, nesting + 1);
    if (node.type === "goto_statement") total += 1;
    if (logicalOperator(node) && !logicalOperator(node.parent!)) total += logicalIncrement(node);
    if (node.type === "call_expression") {
      const callee = calleeText(node);
      if (callee === self || callee === shortSelf) total += 1;
    }
    visitChildren(node, nesting);
  };

  const body = fn.childForFieldName("body");
  if (body) visit(body, 0);
  return total;
}

const DECISIONS = new Set([...LOOPS, "if_statement", "catch_clause", "conditional_expression"]);

/** McCabe cyclomatic complexity of one `function_definition`. */
export function cyclomaticComplexity(fn: Node): number {
  const body = fn.childForFieldName("body");
  if (!body) return 1;
  let total = 1;
  for (const node of walk(body)) {
    if (DECISIONS.has(node.type)) total += 1;
    // `default:` has no value and adds no path.
    else if (node.type === "case_statement" && node.childForFieldName("value")) total += 1;
    else if (logicalOperator(node)) total += 1;
  }
  return total;
}
