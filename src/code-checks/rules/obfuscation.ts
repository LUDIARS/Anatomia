/**
 * @spec C++ code-level static checks
 *
 * src/code-checks/rules/obfuscation.ts — constructs that hide what code does.
 *
 * References: clang-tidy readability-identifier-length,
 * cppcoreguidelines-macro-usage, readability-avoid-nested-conditional-operator,
 * cppcoreguidelines-avoid-goto, and the one-statement-per-line rule of most
 * style guides (Google C++ / LLVM).
 *
 * SRP: obfuscation findings for one parsed file.
 */

import type { Node } from "web-tree-sitter";
import { declaredIdentifier, enclosingFunction, functionName, nodesOfType, position } from "../syntax.js";
import type { CheckFamily, CheckedSource, CodeCheckThresholds, RawFinding } from "../types.js";

const DECLARING = new Set(["declaration", "parameter_declaration", "optional_parameter_declaration", "field_declaration"]);
const STATEMENTS = new Set([
  "expression_statement",
  "declaration",
  "return_statement",
  "break_statement",
  "continue_statement",
  "goto_statement",
  "throw_statement",
]);

function finding(rule: string, node: Node, message: string, extra: Partial<RawFinding> = {}): RawFinding {
  const fn = enclosingFunction(node);
  return { rule, category: "obfuscation", ...position(node), message, ...(fn ? { symbol: functionName(fn) } : {}), ...extra };
}

function declaredNames(root: Node): Node[] {
  const names: Node[] = [];
  for (const node of nodesOfType(root, DECLARING)) {
    for (const declarator of node.childrenForFieldName("declarator")) {
      // Function prototypes are named by their declarator's own identifier.
      const id = declaredIdentifier(declarator);
      if (id) names.push(id);
    }
  }
  for (const fn of nodesOfType(root, new Set(["function_definition"]))) {
    const id = declaredIdentifier(fn.childForFieldName("declarator"));
    if (id) names.push(id);
  }
  for (const type of nodesOfType(root, new Set(["class_specifier", "struct_specifier"]))) {
    const name = type.childForFieldName("name");
    if (name) names.push(name);
  }
  return names;
}

function shortIdentifiers(source: CheckedSource, t: CodeCheckThresholds): RawFinding[] {
  const allow = new Set(t.shortIdentifierAllow);
  return declaredNames(source.root)
    .filter((id) => id.text.length <= t.shortIdentifierMaxLength && !allow.has(id.text))
    .map((id) =>
      finding("obfuscation/short-identifier", id, `\`${id.text}\` is too short to say what it holds`, {
        value: id.text.length,
        threshold: t.shortIdentifierMaxLength,
      }),
    );
}

function functionMacros(source: CheckedSource, t: CodeCheckThresholds): RawFinding[] {
  const macros = nodesOfType(source.root, new Set(["preproc_function_def"]));
  if (macros.length <= t.functionMacrosPerFile) return [];
  const first = macros[t.functionMacrosPerFile]!;
  return [
    finding("obfuscation/function-macro", first, `${macros.length} function-like macros in one file; prefer inline functions or templates`, {
      value: macros.length,
      threshold: t.functionMacrosPerFile,
    }),
  ];
}

function nestedTernaries(source: CheckedSource): RawFinding[] {
  const out: RawFinding[] = [];
  for (const cond of nodesOfType(source.root, new Set(["conditional_expression"]))) {
    const parent = cond.parent;
    // Report the outermost only, once.
    if (parent?.type === "conditional_expression") continue;
    const nested = cond.namedChildren.some((child) => child?.type === "conditional_expression" || child?.type === "parenthesized_expression" && child.namedChildren[0]?.type === "conditional_expression");
    if (nested) out.push(finding("obfuscation/nested-ternary", cond, "nested conditional operator; use if/else or a named helper"));
  }
  return out;
}

function gotos(source: CheckedSource): RawFinding[] {
  return nodesOfType(source.root, new Set(["goto_statement"])).map((node) =>
    finding("obfuscation/goto", node, "`goto` makes control flow non-structured"),
  );
}

function denseLines(source: CheckedSource, t: CodeCheckThresholds): RawFinding[] {
  const out: RawFinding[] = [];
  const perLine = new Map<number, Node[]>();
  for (const statement of nodesOfType(source.root, STATEMENTS)) {
    // A `for (int i = 0; ...)` initializer is part of the loop header, and the
    // `break` closing a one-line `case X: f(); break;` is that idiom's terminator.
    if (statement.parent?.type === "for_statement" || statement.type === "break_statement") continue;
    const row = statement.startPosition.row;
    perLine.set(row, [...(perLine.get(row) ?? []), statement]);
  }
  for (const statements of perLine.values()) {
    if (statements.length > t.statementsPerLine) {
      out.push(finding("obfuscation/dense-line", statements[t.statementsPerLine]!, `${statements.length} statements on one line`, {
        value: statements.length,
        threshold: t.statementsPerLine,
      }));
    }
  }
  source.lines.forEach((line, index) => {
    if (line.length > t.maxLineLength) {
      out.push({
        rule: "obfuscation/long-line",
        category: "obfuscation",
        line: index + 1,
        column: t.maxLineLength + 1,
        message: `line is ${line.length} characters long`,
        value: line.length,
        threshold: t.maxLineLength,
      });
    }
  });
  return out;
}

export const obfuscationFamily: CheckFamily = {
  category: "obfuscation",
  rules: {
    "obfuscation/short-identifier": "warning",
    "obfuscation/function-macro": "warning",
    "obfuscation/nested-ternary": "warning",
    "obfuscation/goto": "warning",
    "obfuscation/dense-line": "warning",
    "obfuscation/long-line": "info",
  },
  check(source, thresholds) {
    return [
      ...shortIdentifiers(source, thresholds),
      ...functionMacros(source, thresholds),
      ...nestedTernaries(source),
      ...gotos(source),
      ...denseLines(source, thresholds),
    ];
  },
};
