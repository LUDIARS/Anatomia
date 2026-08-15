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
import { queryGitIgnoredPaths, type GitIgnoreFailure } from "./git-ignore.js";

/** Directory names never descended into (vendored deps, build output, VCS). */
export const EXCLUDE_DIRS = new Set(["node_modules", "dist", ".git", ".anatomia"]);

/** What the crude reader could and could not take from a root .gitignore. */
export interface GitignoreDirScan {
  /** Bare directory names the reader understood. */
  dirs: Set<string>;
  /**
   * Rules it had to drop — root-anchored, globbed, or containing a path
   * separator. These are silently NOT excluded, which is exactly how a
   * .gitignore made entirely of root-anchored directory rules (a C++ repo
   * hiding its build output and its vendored dependency tree) ends up
   * excluding nothing at all.
   */
  skipped: string[];
}

/**
 * Read `root/.gitignore`, retaining bare directory names and reporting how
 * many rules it could not express. Returns empty collections when the file is
 * absent or unreadable.
 */
export async function scanGitignoreDirs(root: string): Promise<GitignoreDirScan> {
  const dirs = new Set<string>();
  const skipped: string[] = [];
  let text: string;
  try {
    text = await readFile(join(root, ".gitignore"), "utf8");
  } catch {
    return { dirs, skipped };
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    if (line.includes("*") || line.includes("?") || line.includes("[")) {
      skipped.push(line);
      continue;
    }
    if (line.startsWith("/")) {
      skipped.push(line); // root-anchored — the reader cannot anchor
      continue;
    }
    const name = line.endsWith("/") ? line.slice(0, -1) : line;
    if (name && !name.includes("/")) dirs.add(name);
    else skipped.push(line);
  }
  return { dirs, skipped };
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
 *
 * The fallback is never silent when it actually costs coverage. Losing the
 * ignore rules does not fail loudly — it just pulls vendored dependency trees
 * and build output into the walk until the analysis dies of heap exhaustion,
 * with nothing in the log tying that back to a git that refused to answer.
 */
export async function buildIgnorePolicy(
  root: string,
): Promise<{ excludeDirs: Set<string>; isIgnored: IgnorePredicate }> {
  const result = await queryGitIgnoredPaths(root);
  if (!result.ok) {
    const { dirs, skipped } = await scanGitignoreDirs(root);
    warnAboutFallback(result.failure, skipped);
    return { excludeDirs: new Set([...EXCLUDE_DIRS, ...dirs]), isIgnored: () => false };
  }
  return {
    excludeDirs: EXCLUDE_DIRS,
    isIgnored: (path, isDirectory) =>
      isDirectory ? result.paths.dirs.has(path) : result.paths.files.has(path),
  };
}

/**
 * Warn when the fallback is either unexpected (git refused) or lossy (rules the
 * crude reader cannot express). A plain directory with a simple .gitignore stays
 * quiet — that is the case the fallback exists for.
 */
function warnAboutFallback(failure: GitIgnoreFailure, skipped: string[]): void {
  if (failure.kind !== "refused" && skipped.length === 0) return;
  const lost = skipped.length
    ? ` ${skipped.length} rule(s) cannot be expressed by the fallback and will NOT be excluded.`
    : "";
  const cause =
    failure.kind === "refused"
      ? "git refused to report ignored paths"
      : "git could not report ignored paths";
  console.warn(`[anatomia/fs] ${cause}. Falling back to the root .gitignore reader.${lost}`);
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
