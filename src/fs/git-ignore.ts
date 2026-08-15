/**
 * src/fs/git-ignore.ts — ask git which paths are ignored.
 *
 * The walk used to approximate .gitignore by reading the root file and keeping
 * only bare directory names. That misses most of
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
 * Why the ignore query could not be answered.
 *
 * The distinction matters because the two cases deserve different reactions.
 * `unavailable` is the case this fallback was designed for — a plain directory
 * with no repo, where the crude reader is the best available answer and nobody
 * needs telling. `refused` means git was there, understood the request, and
 * declined for a reason an operator can fix (dubious ownership, a broken
 * index, a permissions problem). Treating those the same is how a repository
 * silently loses its ignore rules and drags a 1 GB vendored dependency tree
 * into the analysis.
 */
export type GitIgnoreFailure =
  | { kind: "unavailable"; message: string }
  | { kind: "refused"; message: string };

export type GitIgnoreResult =
  | { ok: true; paths: GitIgnoredPaths }
  | { ok: false; failure: GitIgnoreFailure };

/**
 * Every path git ignores under `root`.
 *
 * Returns null when the answer is unknown — git missing, `root` outside a work
 * tree, or the command failing — so callers can fall back instead of treating
 * "no ignored paths" as a fact.
 *
 * Git reports ignored child directories even when their parent has no tracked
 * files, so those generated trees remain prunable without descending into them.
 */
export async function listGitIgnoredPaths(root: string): Promise<GitIgnoredPaths | null> {
  const result = await queryGitIgnoredPaths(root);
  return result.ok ? result.paths : null;
}

/**
 * As `listGitIgnoredPaths`, but reports *why* the answer is missing so callers
 * can tell a legitimate fallback from a degradation worth warning about.
 */
export async function queryGitIgnoredPaths(root: string): Promise<GitIgnoreResult> {
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
  if (!raw.ok) return raw;

  const dirs = new Set<string>();
  const files = new Set<string>();
  for (const entry of raw.stdout.split("\0")) {
    if (!entry) continue;
    // git reports directories with a trailing slash, always forward slashes.
    if (entry.endsWith("/")) dirs.add(entry.slice(0, -1));
    else files.add(entry);
  }
  return { ok: true, paths: { dirs, files } };
}

type RunGitResult = { ok: true; stdout: string } | { ok: false; failure: GitIgnoreFailure };

/**
 * Classify a failed git invocation.
 *
 * Only two situations are the fallback's intended territory: git is not
 * installed (spawn ENOENT) and the root is not inside a work tree. Anything
 * else is git actively refusing, which the caller should surface rather than
 * paper over.
 */
function classifyGitError(error: unknown): GitIgnoreFailure {
  const err = error as { code?: string; stderr?: string; message?: string };
  const stderr = (err.stderr ?? "").trim();
  const message = stderr || err.message || String(error);
  if (err.code === "ENOENT") return { kind: "unavailable", message: "git executable not found" };
  if (/not a git repository|outside repository/i.test(stderr))
    return { kind: "unavailable", message };
  return { kind: "refused", message };
}

/** Run git in `cwd`, keeping the failure reason instead of collapsing it to null. */
async function runGit(cwd: string, args: string[]): Promise<RunGitResult> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      // node_modules-heavy repos produce a lot of output even with --directory.
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, failure: classifyGitError(error) };
  }
}
