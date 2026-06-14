/**
 * T08 — Diff judgement between two versions of a file.
 *
 * Classify functions by comparing AnchorId (hash) and name:
 *   unchanged : same name present in both, same hash
 *   changed   : same name present in both, different hash (body structure moved)
 *   added     : name only in after
 *   removed   : name only in before
 *
 * Formatting / comment / local-rename edits keep the hash stable -> unchanged.
 * A body-structure edit changes the hash -> changed.
 */

import type { FileNode, FunctionNode } from "../types.js";

export interface DiffResult {
  added: FunctionNode[];
  removed: FunctionNode[];
  /** [before, after] pairs for same-named functions whose hash differs. */
  changed: [FunctionNode, FunctionNode][];
  unchanged: FunctionNode[];
}

/**
 * Index functions by name. Overloads share a name; we key by name+signature
 * to keep distinct overloads apart while still matching across versions.
 */
function keyOf(fn: FunctionNode): string {
  return fn.name + " " + fn.signature;
}

export function diffFiles(before: FileNode, after: FileNode): DiffResult {
  const beforeByKey = new Map<string, FunctionNode>();
  for (const f of before.functions) beforeByKey.set(keyOf(f), f);

  const result: DiffResult = { added: [], removed: [], changed: [], unchanged: [] };
  const seen = new Set<string>();

  for (const a of after.functions) {
    const k = keyOf(a);
    seen.add(k);
    const b = beforeByKey.get(k);
    if (!b) {
      result.added.push(a);
    } else if (b.id === a.id) {
      result.unchanged.push(a);
    } else {
      result.changed.push([b, a]);
    }
  }

  for (const b of before.functions) {
    if (!seen.has(keyOf(b))) result.removed.push(b);
  }

  return result;
}
