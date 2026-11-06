/**
 * @spec C++ code-level static checks
 *
 * src/code-checks/rules/comment.ts — whether code carries the comments a reader needs.
 *
 * References: Doxygen's documented-entity model (a comment block attached
 * directly above a declaration), clang -Wdocumentation, SonarSource S125
 * (commented-out code).
 *
 * The public surface is judged in headers only: in a .cpp the same function is
 * usually documented at its header declaration, which a per-file check cannot see.
 *
 * SRP: comment-presence findings for one parsed file.
 */

import type { Node } from "web-tree-sitter";
import { cognitiveComplexity } from "../cognitive-complexity.js";
import { declaredIdentifier, functionDeclarator, functionDefinitions, functionName, nodesOfType, position, walk } from "../syntax.js";
import type { CheckFamily, CheckedSource, CodeCheckThresholds, RawFinding } from "../types.js";

const CODE_LINE = /(?:;\s*$|^\s*[{}]\s*$|^\s*(?:if|for|while|switch|return|else)\b.*[;{)]\s*$|^\s*#\s*(?:include|define|if)\b)/;

/** The node whose preceding sibling would hold its comment (template wrappers included). */
function attachmentNode(node: Node): Node {
  return node.parent?.type === "template_declaration" ? node.parent : node;
}

function hasLeadingComment(node: Node): boolean {
  const target = attachmentNode(node);
  // Only a comment ending on the line directly above (or on the same line) is
  // attached; one above an access label documents the section, not this member.
  const previous = target.previousSibling;
  return previous?.type === "comment" && previous.endPosition.row >= target.startPosition.row - 1;
}

/** True when `node` sits in a class/struct section that outsiders can reach. */
function isPublicMember(member: Node): boolean {
  const owner = member.parent?.parent;
  let access = owner?.type === "struct_specifier" ? "public" : "private";
  for (const sibling of member.parent?.children ?? []) {
    if (!sibling || sibling.startIndex >= member.startIndex) break;
    if (sibling.type === "access_specifier") access = sibling.text;
  }
  return access === "public";
}

/**
 * Members whose meaning the language fixes: defaulted/deleted special members,
 * destructors and operator overloads. Doxygen-style guides do not ask for these.
 */
function isConventionalMember(node: Node, name: string): boolean {
  if (name.startsWith("~") || name.startsWith("operator")) return true;
  return node.children.some((child) => child?.type === "default_method_clause" || child?.type === "delete_method_clause");
}

function publicSurface(root: Node): { node: Node; name: string; kind: string }[] {
  const surface: { node: Node; name: string; kind: string }[] = [];
  for (const node of walk(root)) {
    if ((node.type === "class_specifier" || node.type === "struct_specifier") && node.childForFieldName("body")) {
      const name = node.childForFieldName("name")?.text;
      // A specifier used inline in a declaration (`struct { } x;`) is documented by that declaration.
      if (name && node.parent?.type !== "field_declaration") surface.push({ node, name, kind: "type" });
      continue;
    }
    const inClass = node.parent?.type === "field_declaration_list";
    const isFunctionDeclaration =
      (node.type === "declaration" || node.type === "field_declaration") &&
      node.childrenForFieldName("declarator").some((d) => d?.type === "function_declarator");
    const isFunctionDefinition = node.type === "function_definition";
    if (!isFunctionDeclaration && !isFunctionDefinition) continue;
    if (inClass && !isPublicMember(node)) continue;
    const scope = inClass ? "member" : node.parent?.type === "translation_unit" || node.parent?.type === "declaration_list" ? "free" : null;
    if (!scope) continue;
    const declarator = isFunctionDefinition ? functionDeclarator(node) : node.childrenForFieldName("declarator").find((d) => d?.type === "function_declarator");
    const name = declaredIdentifier(declarator?.childForFieldName("declarator") ?? null)?.text ?? declarator?.childForFieldName("declarator")?.text;
    // The written name (`~Vec`, `operator+`) — the identifier inside it drops the prefix.
    const written = declarator?.childForFieldName("declarator")?.text ?? "";
    if (name && !isConventionalMember(node, written)) surface.push({ node, name, kind: scope === "member" ? "member function" : "function" });
  }
  return surface;
}

function missingDocs(source: CheckedSource): RawFinding[] {
  if (!source.isHeader) return [];
  return publicSurface(source.root)
    .filter((entry) => !hasLeadingComment(entry.node))
    .map((entry) => ({
      rule: "comment/missing-doc",
      category: "comment" as const,
      ...position(entry.node),
      message: `public ${entry.kind} \`${entry.name}\` has no comment saying what it is for`,
      symbol: entry.name,
    }));
}

function undocumentedComplex(source: CheckedSource, t: CodeCheckThresholds): RawFinding[] {
  const out: RawFinding[] = [];
  for (const fn of functionDefinitions(source.root)) {
    const complexity = cognitiveComplexity(fn);
    if (complexity < t.commentRequiredComplexity) continue;
    if (hasLeadingComment(fn) || nodesOfType(fn, new Set(["comment"])).length > 0) continue;
    out.push({
      rule: "comment/undocumented-complex",
      category: "comment",
      ...position(functionDeclarator(fn) ?? fn),
      message: `function of cognitive complexity ${complexity} has no comment explaining it`,
      symbol: functionName(fn),
      value: complexity,
      threshold: t.commentRequiredComplexity,
    });
  }
  return out;
}

function commentBody(text: string): string[] {
  return text
    .replace(/^\/\*+|\*+\/$/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\/\/+|\*)\s?/, ""))
    .filter((line) => line.trim() !== "");
}

/** Consecutive line comments (one node per `//` line) joined into blocks. */
function commentBlocks(root: Node): Node[][] {
  const blocks: Node[][] = [];
  for (const comment of nodesOfType(root, new Set(["comment"]))) {
    const last = blocks.at(-1)?.at(-1);
    if (last && last.endPosition.row + 1 === comment.startPosition.row && last.text.startsWith("//") && comment.text.startsWith("//")) {
      blocks.at(-1)!.push(comment);
    } else {
      blocks.push([comment]);
    }
  }
  return blocks;
}

/** A block that introduces an example (`Usage:`, `例:`) quotes code on purpose. */
const EXAMPLE_INTRO = /(?:example|usage|e\.g\.|for instance|例|使い方|書式)|:\s*$/i;

function commentedOutCode(source: CheckedSource): RawFinding[] {
  const out: RawFinding[] = [];
  for (const block of commentBlocks(source.root)) {
    const text = block.map((comment) => comment.text).join("\n");
    // Doc comments quote code on purpose (`@code`, examples).
    if (/^\/\/\/|^\/\*\*|^\/\/!|@code|\\code/m.test(text)) continue;
    const lines = block.flatMap((comment) => commentBody(comment.text));
    if (lines.length === 0) continue;
    const codeLike = lines.filter((line) => CODE_LINE.test(line));
    if (codeLike.length * 2 < lines.length) continue;
    if (lines.some((line) => !CODE_LINE.test(line) && EXAMPLE_INTRO.test(line))) continue;
    out.push({
      rule: "comment/commented-out-code",
      category: "comment",
      ...position(block[0]!),
      message: "commented-out code; delete it (version control keeps the history)",
    });
  }
  return out;
}

export const commentFamily: CheckFamily = {
  category: "comment",
  rules: {
    "comment/missing-doc": "warning",
    "comment/undocumented-complex": "info",
    "comment/commented-out-code": "info",
  },
  check(source: CheckedSource, thresholds) {
    return [...missingDocs(source), ...undocumentedComplex(source, thresholds), ...commentedOutCode(source)];
  },
};
