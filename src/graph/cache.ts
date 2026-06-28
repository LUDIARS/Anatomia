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
 * filesContentKey folds each file's PATH + structural Merkle hash: stable across
 * a spec edit, and changed the moment any code file changes (then the graph
 * genuinely must be rebuilt; verify's per-diff augmentGraph overlay sits on top
 * of this cached base, unchanged).
 *
 * In-process only: CodeGraph holds Maps and is shared by reference — read-only,
 * since augmentGraph shallow-copies before overlaying — so there is nothing to
 * serialise and a warm server reuses the same object.
 *
 * SRP: key derivation + cache type only. The lookup lives at the call site.
 */

import { createHash } from "node:crypto";
import { versionedKey, type CacheStore } from "../cache/store.js";
import type { CodeGraph } from "./build.js";
import type { FileNode } from "../types.js";

/** BUMP when CodeGraph's shape or buildGraph's semantics change. */
export const GRAPH_CACHE_VERSION = "1";

/**
 * Code identity for graph/detection reuse: each file's path + structural Merkle
 * hash (sorted, hashed). A content edit OR a rename changes it; a spec/config
 * edit (no code change) does not.
 */
export function filesContentKey(files: FileNode[]): string {
  const stamps = files
    .map((f) => `${f.path.replace(/\\/g, "/")}\0${f.hash ?? ""}`)
    .sort();
  return createHash("sha256").update(stamps.join("\n"), "utf8").digest("hex");
}

/** Cache key for the built graph over `files`. */
export function graphCacheKey(files: FileNode[]): string {
  return versionedKey(filesContentKey(files), "graph", GRAPH_CACHE_VERSION);
}

/** Content-addressed store for built code graphs (in-process). */
export type GraphCache = CacheStore<CodeGraph>;
