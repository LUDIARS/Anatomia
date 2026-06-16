/**
 * src/fs/walk.ts — directory-pruning source-file walk.
 *
 * The analysis + fingerprint passes only ever care about a project's own source
 * (.cpp/.h/.cs/.ts/.tsx/.md), never its vendored deps or build output. A naive
 * `readdir(root, { recursive: true })` still *enumerates* node_modules/dist in
 * full before any filter runs — on a real repo that is tens of thousands of
 * entries and turns a sub-second scan into minutes. This walk prunes excluded
 * directories at the directory level (it never descends into them) so the cost
 * is proportional to the source tree, not the vendored tree.
 *
 * Symlinks are not followed (a symlinked dir reports isDirectory() === false),
 * which also avoids cycles via junctions (e.g. a node_modules junction).
 *
 * SRP: filesystem traversal only. Extension sets + exclusion policy are passed
 * in by callers (core.ts analyze, project/cache.ts fingerprint).
 */
import { readdir } from "node:fs/promises";
import { join, extname } from "node:path";

/** Directory names never descended into (vendored deps, build output, VCS). */
export const EXCLUDE_DIRS = new Set(["node_modules", "dist", ".git", ".anatomia"]);

/**
 * Recursively collect files under `dir` whose extension is in `exts`, pruning
 * any directory whose name is in `excludeDirs` (default EXCLUDE_DIRS). Unreadable
 * directories are skipped, never fatal.
 */
export async function collectFilesByExt(
  dir: string,
  exts: Set<string>,
  excludeDirs: Set<string> = EXCLUDE_DIRS,
): Promise<string[]> {
  const result: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip, do not crash the whole walk
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!excludeDirs.has(entry.name)) stack.push(join(current, entry.name));
      } else if (entry.isFile() && exts.has(extname(entry.name).toLowerCase())) {
        result.push(join(current, entry.name));
      }
    }
  }
  return result;
}
