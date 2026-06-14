/**
 * T07 — File / module Merkle DAG.
 *
 * A FileNode's hash is the SHA-256 over its child function hashes, sorted
 * alphabetically and concatenated. A repo node hashes over its files' hashes
 * the same way. Sorting makes the hash order-independent: reordering functions
 * within a file leaves the file hash unchanged; changing one function changes
 * exactly that function's hash and therefore the file (and repo) hash.
 */

import { createHash } from "node:crypto";
import type { AnchorId, FileNode, FunctionNode } from "../types.js";

/** SHA-256 (full hex) over a sorted, newline-joined list of child hashes. */
function merkleHash(childHashes: string[]): string {
  const sorted = [...childHashes].sort();
  return createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex");
}

/**
 * Build a FileNode (with computed Merkle hash) from its functions.
 * Each function MUST already have its `id` assigned (T06).
 */
export function buildFileNode(filePath: string, functions: FunctionNode[]): FileNode {
  const childHashes = functions.map((f) => {
    if (f.id == null) {
      throw new Error(
        `buildFileNode: function "${f.name}" has no AnchorId (run hash step first)`,
      );
    }
    return f.id as string;
  });
  return {
    path: filePath,
    hash: merkleHash(childHashes),
    functions,
  };
}

export interface RepoNode {
  hash: string;
  files: FileNode[];
}

/** Build a repo-level Merkle node over a set of FileNodes. */
export function buildRepoNode(files: FileNode[]): RepoNode {
  const childHashes = files.map((f) => {
    if (f.hash == null) {
      throw new Error(`buildRepoNode: file "${f.path}" has no hash (run buildFileNode first)`);
    }
    return f.hash;
  });
  return {
    hash: merkleHash(childHashes),
    files,
  };
}

/** Re-export the anchor type alias for downstream convenience. */
export type { AnchorId };
