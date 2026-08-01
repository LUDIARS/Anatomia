/**
 * src/fs/git-ignore.ts — ask git which paths are ignored.
 *
 * The walk used to approximate .gitignore by reading the root file and keeping
 * only bare directory names (readGitignoreDirs in walk.ts). That misses most of
 * what real repos write — `/dist`, `build/*.o`, nested .gitignore files,
 * .git/info/exclude, the global core.excludesFile — so generated output,
 * vendored copies and logs kept leaking into the code graph.
 *
 * Rather than grow a pattern engine, ask git. One `ls-files` call returns every
 * ignored path under the root with git's own semantics, and `--directory`
 * collapses fully-ignored directories so the walk can prune instead of
 * descending.
 *
 * Untracked-but-not-ignored files are deliberately still analyzed: `--others
 * --ignored` lists only paths the ignore rules match, and a *tracked* file
 * always wins over a matching rule (git does not ignore what it already
 * tracks). Freshly written files therefore stay visible to the verify pass,
 * which is where they matter most.
 *
 * SRP: shells out to git and returns plain path sets. No walking, no policy.
 * (branch/git.ts has a similar private helper, but `fs` must not depend on the
 * `branch` layer, so the 10-line exec wrapper is repeated rather than shared.)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Ignored paths under a root, relative to it, with forward slashes. */
export interface GitIgnoredPaths {
  /** Fully-ignored directories (no trailing slash). Prune these. */
  dirs: Set<string>;
  /** Individually ignored files inside directories that are not fully ignored. */
  files: Set<string>;
}

/**
 * Every path git ignores under `root`.
 *
 * Returns null when the answer is unknown — git missing, `root` outside a work
 * tree, or the command failing — so callers can fall back instead of treating
 * "no ignored paths" as a fact.
 *
 * Known gap: `--directory` also collapses a directory that contains no tracked
 * file at all, and a collapsed directory hides the ignored paths beneath it. So
 * ignored files inside a wholly-untracked directory (a brand-new feature dir, a
 * repo with no commits yet) are not reported. That errs toward analyzing too
 * much rather than excluding something wrongly, which is the safe direction —
 * and the case disappears as soon as anything in that directory is committed.
 * Dropping `--directory` would close it but cost the directory-level pruning
 * that keeps huge ignored trees (Unity `Library/`, `build/`) off the walk.
 */
export async function listGitIgnoredPaths(root: string): Promise<GitIgnoredPaths | null> {
  const raw = await runGit(root, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    // Collapse a fully-ignored directory into one entry so the walk can prune
    // it. Without this, git lists every file inside node_modules one by one.
    "--directory",
  ]);
  if (raw === null) return null;

  const dirs = new Set<string>();
  const files = new Set<string>();
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    // git reports directories with a trailing slash, always forward slashes.
    if (entry.endsWith("/")) dirs.add(entry.slice(0, -1));
    else files.add(entry);
  }
  return { dirs, files };
}

/** Run git in `cwd`; null on any failure (missing git, not a repo, bad args). */
async function runGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      // node_modules-heavy repos produce a lot of output even with --directory.
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}
