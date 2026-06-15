/**
 * T14 — NodeFilter matching helpers for the predicate engine.
 *
 * SRP: this file ONLY decides whether a CodeNode matches a NodeFilter and
 * exposes small set helpers over node collections. Predicate *evaluation*
 * lives in engine.ts; the Predicate ADT itself lives in types.ts.
 *
 * A NodeFilter matches by kind / namePattern (regex) / tags. All present
 * fields are ANDed; an empty filter matches every node. A node matches the
 * `tags` field only when it carries ALL listed tags.
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
  return nodes.filter((n) => matchesFilter(n, filter));
}
