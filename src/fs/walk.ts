/**
 * src/fs/walk.ts — directory-pruning source-file walk.
 *
 * The analysis + fingerprint passes only ever care about a project's own source
 * (.cpp/.h/.cs/.js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts/.md), never its vendored
 * deps or build output. A naive
 * `readdir(root, { recursive: true })` still *enumerates* node_modules/dist in
 * full before any filter runs — on a real repo that is tens of thousands of
 * entries and turns a sub-second scan into minutes. This walk prunes excluded
 * directories at the directory level (it never descends into them) so the cost
 * is proportional to the source tree, not the vendored tree.
 *
 * Symlinks are not followed (a symlinked dir reports isDirectory() === false),
 * which also avoids cycles via junctions (e.g. a node_modules junction).
 *
 * SRP: traversal plus the one exclusion policy every analysis walk shares —
 * the built-in prune list above and whatever git ignores (./git-ignore.ts).
 * Extension sets stay with the callers (core.ts analyze, project/fingerprint.ts,
 * project/spec-detect.ts), and they go through `collectProjectFiles` rather
 * than assembling exclusion sets around raw `collectFilesByExt`.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, extname, relative } from "node:path";
import { listGitIgnoredPaths } from "./git-ignore.js";

/** Directory names never descended into (vendored deps, build output, VCS). */
export const EXCLUDE_DIRS = new Set(["node_modules", "dist", ".git", ".anatomia"]);

/**
 * Read `root/.gitignore` and return the set of simple directory names that
 * should be excluded from the walk. Only handles bare names (`Library`) and
 * trailing-slash forms (`Library/`) without wildcards or path anchors — glob
 * patterns, negations, and mid-path slashes are ignored.
 *
 * Returns an empty set if .gitignore is absent or unreadable.
 */
export async function readGitignoreDirs(root: string): Promise<Set<string>> {
  const result = new Set<string>();
  let text: string;
  try {
    text = await readFile(join(root, ".gitignore"), "utf8");
  } catch {
    return result;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    if (line.includes("*") || line.includes("?") || line.includes("[")) continue;
    if (line.startsWith("/")) continue; // root-anchored — skip
    const name = line.endsWith("/") ? line.slice(0, -1) : line;
    if (name && !name.includes("/")) result.add(name);
  }
  return result;
}

/**
 * Recursively collect files under `dir` whose extension is in `exts`, pruning
 * any directory whose name is in `excludeDirs` (default EXCLUDE_DIRS). Unreadable
 * directories are skipped, never fatal.
 */
export async function collectFilesByExt(
  dir: string,
  exts: Set<string>,
  excludeDirs: Set<string> = EXCLUDE_DIRS,
  isIgnored: IgnorePredicate = () => false,
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
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        if (isIgnored(relPath(dir, full), true)) continue;
        stack.push(full);
      } else if (entry.isFile() && exts.has(extname(entry.name).toLowerCase())) {
        if (isIgnored(relPath(dir, full), false)) continue;
        result.push(full);
      }
    }
  }
  return result;
}

/**
 * Decides whether a path found by the walk should be dropped.
 * `path` is relative to the walk root, forward slashes, no trailing slash.
 */
export type IgnorePredicate = (path: string, isDirectory: boolean) => boolean;

/** Walk-root-relative path in git's shape (forward slashes). */
function relPath(root: string, full: string): string {
  return relative(root, full).replace(/\\/g, "/");
}

/**
 * The exclusion policy every analysis walk shares: built-in vendored/build
 * directories plus whatever git ignores.
 *
 * Falls back to the crude root-.gitignore reader when git cannot answer (no
 * git, not a work tree). That path is strictly worse but keeps non-git
 * directories analyzable, which the CLI relies on.
 */
export async function buildIgnorePolicy(
  root: string,
): Promise<{ excludeDirs: Set<string>; isIgnored: IgnorePredicate }> {
  const ignored = await listGitIgnoredPaths(root);
  if (!ignored) {
    const gitDirs = await readGitignoreDirs(root);
    return { excludeDirs: new Set([...EXCLUDE_DIRS, ...gitDirs]), isIgnored: () => false };
  }
  return {
    excludeDirs: EXCLUDE_DIRS,
    isIgnored: (path, isDirectory) =>
      isDirectory ? ignored.dirs.has(path) : ignored.files.has(path),
  };
}

/**
 * Collect a project's own source files: the pruning walk with the shared
 * exclusion policy applied. The single entry point for analysis-facing
 * discovery — callers should not assemble exclusion sets themselves.
 */
export async function collectProjectFiles(root: string, exts: Set<string>): Promise<string[]> {
  const { excludeDirs, isIgnored } = await buildIgnorePolicy(root);
  return collectFilesByExt(root, exts, excludeDirs, isIgnored);
}
