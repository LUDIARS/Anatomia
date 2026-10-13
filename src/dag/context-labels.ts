/**
 * src/dag/context-labels.ts — extra declaration-context labels that tell apart
 * functions whose name, owner and callback slot are otherwise identical.
 *
 * The function-complexity snapshot keys a function by path + owner + name +
 * signature + lexical context (extract.ts `declarationContext`). Two kinds of
 * repetition still produced identical keys although the source distinguishes
 * them, and a single ambiguous key makes the PR comparison fall back to the
 * aggregate score for the whole tree:
 *
 *   - registered callbacks whose distinguishing argument is not a string —
 *     React `useEffect(() => …, [a])` / `useEffect(() => …, [b])` in one
 *     component (the dominant case measured in Excubitor);
 *   - one method defined per preprocessor branch (`#if UNITY … #else … #endif`).
 *
 * Labels only use source structure that is stable under body edits and line
 * shifts. Repetition the source does not distinguish stays ambiguous: no
 * ordinal is invented, so a consumer never pairs the wrong occurrences.
 *
 * SRP: compute the labels. extract.ts decides where they go.
 *
 * @spec Function complexity comparison
 */

import type { Node } from "web-tree-sitter";

/** Array elements allowed in a dependency-list label (`[a, b.c, "k"]`). */
const ARRAY_ELEMENT_TYPES = new Set<string>(["string", "identifier", "member_expression", "this"]);

/**
 * Registration labels of a callback's sibling arguments: string literals (as
 * before) plus identifier-only arrays such as React dependency lists. Numbers
 * are left out on purpose — `setTimeout(fn, 100)` → `200` is a body-level edit,
 * not a different registration. Functions, objects and calls never contribute.
 */
export function argumentLabels(args: readonly Node[], slot: number): string[] {
  const labels: string[] = [];
  args.forEach((arg, index) => {
    if (index === slot) return;
    if (arg.type === "string") labels.push(arg.text);
    else if (arg.type === "array" && arg.namedChildren.every((element) => element !== null && ARRAY_ELEMENT_TYPES.has(element.type))) {
      labels.push(`[${arg.namedChildren.map((element) => element!.text.replace(/\s+/g, "")).join(",")}]`);
    }
  });
  return labels;
}

/** C++ preprocessor container nodes (nested: the branch is an ancestor). */
const NESTED_PREPROC_TYPES = new Set<string>(["preproc_if", "preproc_ifdef", "preproc_elif", "preproc_else", "preproc_elifdef"]);

/** Label of a C++ preprocessor ancestor, or null for other node types. */
export function nestedPreprocessorLabel(node: Node): string | null {
  if (!NESTED_PREPROC_TYPES.has(node.type)) return null;
  if (node.type === "preproc_else") return "preproc:else";
  const condition = node.childForFieldName("condition") ?? node.childForFieldName("name");
  return `preproc:${node.type.replace("preproc_", "")}:${(condition?.text ?? "").replace(/\s+/g, " ").trim()}`;
}

/**
 * C# directives are FLAT siblings (`if_directive`, method, `else_directive`,
 * method, `endif_directive`), so the branch is found by scanning back over the
 * preceding siblings, skipping nested `#if … #endif` blocks.
 */
export function flatDirectiveLabel(node: Node): string | null {
  let depth = 0;
  let branch: string | null = null;
  for (let sibling = node.previousNamedSibling; sibling; sibling = sibling.previousNamedSibling) {
    const type = sibling.type;
    if (type === "endif_directive") depth++;
    else if (type === "if_directive") {
      if (depth > 0) { depth--; continue; }
      const condition = directiveCondition(sibling);
      return branch ? `preproc:${branch}:${condition}` : `preproc:if:${condition}`;
    } else if (depth === 0 && branch === null && (type === "elif_directive" || type === "else_directive")) {
      branch = type === "elif_directive" ? `elif:${directiveCondition(sibling)}` : "else";
    }
  }
  return null;
}

function directiveCondition(directive: Node): string {
  return directive.namedChildren.map((child) => child?.text ?? "").join(" ").replace(/\s+/g, " ").trim();
}
