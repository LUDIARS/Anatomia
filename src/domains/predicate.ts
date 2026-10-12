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
 *
 * When the caller knows the repo root, the pattern is ALSO tested against the
 * repo-relative path. The node's path is absolute whenever the repo was given as
 * an absolute path (`pr-review --repo E:/…/Actio`), so a `^src/…` membership
 * pattern matched nothing there and the PR came back "target domain missing",
 * while the same review with `--repo .` passed. Either form matching is enough:
 * existing segment patterns (`/enemy/`, `(^|/)src/`) keep matching the absolute
 * path, and `^`-anchored ones now match the repo-relative one.
 */

import { toRepoRelative } from "../fs/repo-path.js";
import type { CodeNode, NodeFilter } from "../types.js";

/** Where the matched nodes live; lets `pathPattern` see repo-relative paths. */
export interface FilterContext {
  /** Absolute repo root the node paths were parsed under. */
  repoRoot?: string;
}

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
export function matchesFilter(node: CodeNode, filter: NodeFilter, context: FilterContext = {}): boolean {
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
    if (!filterPaths(node.sourceRange.filePath, context).some((path) => re.test(path))) return false;
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
export function selectNodes(nodes: CodeNode[], filter: NodeFilter, context: FilterContext = {}): CodeNode[] {
  return nodes.filter((node) => matchesFilter(node, filter, context));
}

/** The forward-slashed path, plus its repo-relative form when that differs. */
function filterPaths(filePath: string, context: FilterContext): string[] {
  const path = filePath.replace(/\\/g, "/");
  if (!context.repoRoot) return [path];
  const relative = toRepoRelative(path, context.repoRoot);
  return relative === path ? [path] : [path, relative];
}
