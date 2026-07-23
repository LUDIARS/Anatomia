/**
 * T14 — NodeFilter matching helpers for the predicate engine.
 *
 * SRP: this file ONLY decides whether a CodeNode matches a NodeFilter and
 * exposes small set helpers over node collections. Predicate *evaluation*
 * lives in engine.ts; the Predicate ADT itself lives in types.ts.
 *
 * A NodeFilter matches by kind / namePattern (regex) /
 * signatureShapePattern (regex over FunctionNode.signatureShape) / pathPattern
 * (regex over the source file path) / tags. All present fields are ANDed; an
 * empty filter matches every node. A node matches the `tags` field only when it
 * carries ALL listed tags. Function-identity matching fails closed when the
 * caller has not enriched the CodeNode with a signature shape.
 *
 * `pathPattern` is tested against the node's source file path normalised to
 * forward slashes (so ontology patterns like `/enemy/` are OS-independent). It
 * is what lets directory-structured codebases (e.g. a game's enemy/ combat/
 * render/ layout) express layer rules by location rather than by name.
 */

import type { CodeNode, NodeFilter } from "../types.js";

/** Cache compiled regexes so repeated evaluation does not recompile. */
const regexCache = new Map<string, RegExp>();

function compileRegex(src: string): RegExp {
  const cached = regexCache.get(src);
  if (cached) return cached;
  const re = new RegExp(src);
  regexCache.set(src, re);
  return re;
}

/** Does a single node satisfy the filter? */
export function matchesFilter(node: CodeNode, filter: NodeFilter): boolean {
  if (filter.kind !== undefined && node.kind !== filter.kind) return false;

  if (filter.namePattern !== undefined) {
    const re = compileRegex(filter.namePattern);
    if (!re.test(node.name)) return false;
  }

  if (filter.signatureShapePattern !== undefined) {
    if (node.signatureShape === undefined) return false;
    const re = compileRegex(filter.signatureShapePattern);
    if (!re.test(node.signatureShape)) return false;
  }

  if (filter.pathPattern !== undefined) {
    const re = compileRegex(filter.pathPattern);
    const path = node.sourceRange.filePath.replace(/\\/g, "/");
    if (!re.test(path)) return false;
  }

  if (filter.tags !== undefined && filter.tags.length > 0) {
    const nodeTags = node.tags ?? [];
    for (const t of filter.tags) {
      if (!nodeTags.includes(t)) return false;
    }
  }

  return true;
}

/** Return the subset of `nodes` that match the filter. */
export function selectNodes(nodes: CodeNode[], filter: NodeFilter): CodeNode[] {
  return nodes.filter((node) => matchesFilter(node, filter));
}
