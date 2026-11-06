/**
 * @spec C++ code-level static checks
 *
 * src/code-checks/rules/complexity.ts — functions too complex for a human
 * reader: cognitive and cyclomatic complexity, body length, parameter count.
 *
 * References: SonarSource Cognitive Complexity (S3776, default 15), lizard
 * (CCN 15), clang-tidy readability-function-size / readability-function-cognitive-complexity.
 *
 * SRP: threshold findings over per-function measurements.
 */

import type { Node } from "web-tree-sitter";
import { cognitiveComplexity, cyclomaticComplexity } from "../cognitive-complexity.js";
import { functionDeclarator, functionDefinitions, functionName, parameters, position } from "../syntax.js";
import type { CheckFamily, CheckedSource, CodeCheckThresholds, RawFinding } from "../types.js";

function over(rule: string, fn: Node, value: number, threshold: number, what: string): RawFinding[] {
  if (value <= threshold) return [];
  const anchor = functionDeclarator(fn) ?? fn;
  return [
    {
      rule,
      category: "complexity",
      ...position(anchor),
      message: `${what} is ${value} (limit ${threshold})`,
      symbol: functionName(fn),
      value,
      threshold,
    },
  ];
}

function bodyLines(fn: Node): number {
  const body = fn.childForFieldName("body");
  return body ? body.endPosition.row - body.startPosition.row + 1 : 0;
}

function check(fn: Node, t: CodeCheckThresholds): RawFinding[] {
  return [
    ...over("complexity/cognitive", fn, cognitiveComplexity(fn), t.cognitiveComplexity, "cognitive complexity"),
    ...over("complexity/cyclomatic", fn, cyclomaticComplexity(fn), t.cyclomaticComplexity, "cyclomatic complexity"),
    ...over("complexity/function-length", fn, bodyLines(fn), t.functionLength, "function body length in lines"),
    ...over("complexity/parameter-count", fn, parameters(fn).length, t.parameterCount, "parameter count"),
  ];
}

export const complexityFamily: CheckFamily = {
  category: "complexity",
  rules: {
    "complexity/cognitive": "warning",
    "complexity/cyclomatic": "warning",
    "complexity/function-length": "warning",
    "complexity/parameter-count": "warning",
  },
  check(source: CheckedSource, thresholds) {
    return functionDefinitions(source.root).flatMap((fn) => check(fn, thresholds));
  },
};
