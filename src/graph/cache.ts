/**
 * src/graph/cache.ts — content-addressed cache for the built code graph.
 *
 * analyze() Phase 2/3 (extractEdgeInfo over every file's bodyAst + buildGraph)
 * is the largest uncached slice of a re-analysis: on the measured Anatomia tree
 * (310 files / 2161 functions) the per-file + detection caches cut analyze ~40%,
 * and the remaining floor is edge extraction + graph build. Those re-run on every
 * fingerprint MISS — including a spec/config-only edit, which busts the
 * fingerprint but leaves the code (hence the graph) identical. Keying the built
 * CodeGraph by code identity lets that path reuse the graph.
 *
 * filesContentKey folds each file's PATH + raw source content hash: stable across
 * a spec/config-only edit, and changed by any source edit or rename. Raw content
 * matters because type declarations affect graph resolution even when function
 * Merkle hashes do not. verify's per-diff augmentGraph overlay sits on top of
 * this cached base, unchanged.
 *
 * In-process only: CodeGraph holds Maps and is shared by reference — read-only,
 * since augmentGraph shallow-copies before overlaying — so there is nothing to
 * serialise and a warm server reuses the same object.
 *
 * SRP: key derivation + cache type only. The lookup lives at the call site.
 */

import { createHash } from "node:crypto";
import { versionedKey, type CacheStore } from "../cache/store.js";
import { toRepoRelative } from "../fs/repo-path.js";
import type { CodeGraph } from "./build.js";
import type { AnchorId, CodeNode, FileNode, SourceRange } from "../types.js";

/** BUMP when CodeGraph's shape or buildGraph's semantics change. */
export const GRAPH_CACHE_VERSION = "2"; // 2: CodeGraph.unresolved (dropped-call records)

/**
 * Code identity for graph/detection reuse: each file's path + raw source hash
 * (sorted, hashed). Hand-built FileNodes without `contentHash` fall back to the
 * structural Merkle hash. A source edit OR rename changes the key; a spec/config
 * edit (no source change) does not.
 *
 * Paths are folded REPO-RELATIVE when a root is given. With absolute paths the
 * same commit checked out twice (a repo and a Revisor review worktree) produced
 * two different keys, so the process-shared store could never serve one checkout
 * from another's entry — the identity described the machine, not the project.
 */
export function filesContentKey(files: FileNode[], repoRoot?: string): string {
  const stamps = files
    .map((f) => {
      const path = repoRoot ? toRepoRelative(f.path, repoRoot) : f.path.replace(/\\/g, "/");
      return `${path}\0${f.contentHash ?? f.hash ?? ""}`;
    })
    .sort();
  return createHash("sha256").update(stamps.join("\n"), "utf8").digest("hex");
}

/** Cache key for the built graph over `files`. */
export function graphCacheKey(files: FileNode[], repoRoot?: string): string {
  return versionedKey(filesContentKey(files, repoRoot), "graph", GRAPH_CACHE_VERSION);
}

function sameSourceRange(left: SourceRange, right: SourceRange): boolean {
  return left.filePath === right.filePath
    && left.start.line === right.start.line
    && left.start.column === right.start.column
    && left.end.line === right.end.line
    && left.end.column === right.end.column;
}

/**
 * Project a cached graph's diagnostic locations onto the current FileNodes.
 *
 * The cache key deliberately ignores checkout roots. Edges remain reusable
 * across roots, but CodeNode.sourceRange does not: returning it unchanged leaks
 * a different worktree's absolute paths. Clone only the node map when a location
 * differs; the immutable edge containers remain shared.
 */
export function localizeCachedGraph(graph: CodeGraph, files: FileNode[]): CodeGraph {
  const currentRanges = new Map<AnchorId, SourceRange>();
  for (const file of files) {
    for (const fn of file.functions) {
      if (fn.id) currentRanges.set(fn.id, fn.sourceRange);
    }
  }

  let localizedNodes: Map<AnchorId, CodeNode> | undefined;
  for (const [id, node] of graph.nodes) {
    const current = currentRanges.get(id);
    if (!current || sameSourceRange(node.sourceRange, current)) continue;
    localizedNodes ??= new Map(graph.nodes);
    localizedNodes.set(id, { ...node, sourceRange: current });
  }

  return localizedNodes ? { ...graph, nodes: localizedNodes } : graph;
}

/** Content-addressed store for built code graphs (in-process). */
export type GraphCache = CacheStore<CodeGraph>;
