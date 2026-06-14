/**
 * T09 — Incremental re-index.
 *
 * Re-parse ONLY the files present in changedFiles, rebuild their FileNodes
 * (functions -> normalize -> hash -> Merkle), and return a new DAG map. Files
 * not in changedFiles are carried over untouched (same object reference), so
 * their subtree hashes are preserved without re-parsing.
 *
 * This is the function-granularity analogue of Merkle invalidation: a single
 * changed file only recomputes that file's node; unaffected nodes are reused.
 */

import type { FileNode, Lang } from "../types.js";
import { parse } from "./parser.js";
import { extractFunctions } from "./extract.js";
import { normalize } from "./normalize.js";
import { assignAnchorId } from "./hash.js";
import { buildFileNode } from "./merkle.js";

/** Parse one source string into a fully-hashed FileNode. */
export async function buildFileNodeFromSource(
  filePath: string,
  source: string,
  lang: Lang,
): Promise<FileNode> {
  const tree = await parse(source, lang);
  try {
    const functions = extractFunctions(tree, source, filePath);
    for (const fn of functions) {
      assignAnchorId(fn, normalize(fn.bodyAst));
    }
    return buildFileNode(filePath, functions);
  } finally {
    tree.delete();
  }
}

/**
 * Incrementally re-index a DAG.
 *
 * @param dag          current DAG: filePath -> FileNode
 * @param changedFiles filePath -> new source text (only these are re-parsed)
 * @param lang         language of the changed files
 * @returns a NEW Map with changed files rebuilt and the rest carried over.
 */
export async function reindex(
  dag: Map<string, FileNode>,
  changedFiles: Map<string, string>,
  lang: Lang,
): Promise<Map<string, FileNode>> {
  const next = new Map<string, FileNode>(dag); // carry untouched files over
  for (const [filePath, source] of changedFiles) {
    next.set(filePath, await buildFileNodeFromSource(filePath, source, lang));
  }
  return next;
}
