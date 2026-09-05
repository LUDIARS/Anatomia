/**
 * src/branch/git.ts — Minimal Git process primitives.
 *
 * SRP: shells out to `git` and returns plain data. No parsing, no diff
 * classification, repository policy, or HTTP. Used by branch/diff.ts for branch
 * changes and by map/project-roots.ts for checkout identity.
 *
 * Everything here degrades gracefully: a non-git directory, a missing ref, or
 * an absent file resolves to null/[]/false rather than throwing, so the
 * callers can degrade to path identity or a no-op outside a Git checkout.
 */

import { execFile } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Candidate base branches tried, in order, when none is requested. */
export const DEFAULT_BASE_CANDIDATES: readonly string[] = [
  "origin/main",
  "main",
  "origin/master",
  "master",
];

/** Run a git command in `cwd`; return trimmed stdout, or null on any failure. */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.replace(/\r?\n$/, "");
  } catch {
    return null;
  }
}

/** True when `rootPath` is inside a git work tree. */
export async function isGitRepo(rootPath: string): Promise<boolean> {
  const out = await git(rootPath, ["rev-parse", "--is-inside-work-tree"]);
  return out === "true";
}

/** The two checkout roots a path belongs to. */
export interface RepoRoots {
  /** Toplevel of the working tree the path is in, forward-slashed. */
  worktree: string;
  /**
   * Root of the MAIN checkout. A linked worktree resolves to the repository it
   * was added from; a normal checkout resolves to itself.
   */
  main: string;
}

/**
 * Resolve which repository a path belongs to, and which checkout of it.
 *
 * `--git-common-dir` is the whole point: every linked worktree shares the main
 * checkout's git dir, so its parent is the one identity two worktrees of the
 * same repository agree on. Callers that must not count one repository twice
 * (the domain map's project registry) key on `main`.
 *
 * Returns null outside a git checkout, like everything else here.
 */
export async function resolveRepoRoots(path: string): Promise<RepoRoots | null> {
  const out = await git(path, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
  ]);
  if (out === null) return null;
  const [worktree, commonDir] = out.split(/\r?\n/);
  if (!worktree || !commonDir) return null;
  // Absolute output avoids interpreting a relative common-dir against the wrong
  // directory when the registered analysis root is a repository subdirectory.
  const gitDir = resolve(path, commonDir);
  const main = basename(gitDir) === ".git" ? dirname(gitDir) : worktree;
  return { worktree: forwardSlashed(worktree), main: forwardSlashed(main) };
}

/** Forward-slashed, trailing-separator-free form, so two spellings compare equal. */
function forwardSlashed(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Current branch name (or null when detached / not a repo). */
export async function currentBranch(rootPath: string): Promise<string | null> {
  const out = await git(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return out && out !== "HEAD" ? out : null;
}

/** Short HEAD commit hash (or null). */
export async function headSha(rootPath: string): Promise<string | null> {
  return git(rootPath, ["rev-parse", "--short", "HEAD"]);
}

export interface ResolvedBase {
  /** The base branch label chosen (e.g. "origin/main"). */
  ref: string;
  /** The merge-base commit between `ref` and HEAD (the fork point). */
  mergeBase: string;
}

/**
 * Resolve the base to diff against. When `requested` is given it is used as the
 * ref; otherwise the first of DEFAULT_BASE_CANDIDATES that exists is chosen.
 * In both cases the returned `mergeBase` is `git merge-base <ref> HEAD` so the
 * diff captures exactly what this branch introduced since it forked (not
 * unrelated commits that landed on the base afterwards).
 *
 * Returns null when no usable base/merge-base can be found.
 */
export async function resolveBase(
  rootPath: string,
  requested?: string,
): Promise<ResolvedBase | null> {
  const candidates = requested ? [requested] : DEFAULT_BASE_CANDIDATES;
  for (const ref of candidates) {
    // Verify the ref resolves to a commit before asking for a merge-base.
    const verified = await git(rootPath, ["rev-parse", "--verify", "--quiet", ref]);
    if (!verified) continue;
    const mb = await git(rootPath, ["merge-base", ref, "HEAD"]);
    if (mb) return { ref, mergeBase: mb };
  }
  return null;
}

/**
 * List candidate base refs to diff against: local branches + remote-tracking
 * branches (e.g. "main", "origin/main"), excluding the current branch and
 * remote HEAD pointers. The well-known DEFAULT_BASE_CANDIDATES are surfaced
 * first (in their canonical order); the rest follow sorted. Empty outside a
 * git repo.
 */
export async function listBranches(rootPath: string): Promise<string[]> {
  const out = await git(rootPath, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ]);
  if (!out) return [];
  const cur = await currentBranch(rootPath);
  const refs = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((r) => r.length > 0 && !r.endsWith("/HEAD") && r !== cur);
  const seen = new Set(refs);
  const known = DEFAULT_BASE_CANDIDATES.filter((c) => seen.has(c));
  const rest = refs.filter((r) => !known.includes(r)).sort();
  return [...known, ...rest];
}

/**
 * Source files changed between `mergeBase` and the working tree, plus new
 * untracked files. Paths are absolute-relative to `rootPath` as git reports
 * them (forward slashes). Includes both committed-on-branch and uncommitted
 * edits — the full set of code this branch differs from base by.
 */
export async function changedFiles(
  rootPath: string,
  mergeBase: string,
): Promise<string[]> {
  const tracked = await git(rootPath, [
    "diff",
    "--name-only",
    "--diff-filter=ACMRD",
    mergeBase,
  ]);
  const untracked = await git(rootPath, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  const set = new Set<string>();
  for (const block of [tracked, untracked]) {
    if (!block) continue;
    for (const line of block.split(/\r?\n/)) {
      const p = line.trim();
      if (p) set.add(p);
    }
  }
  return [...set];
}

/** Max characters of pathspec arguments per `git diff` invocation. */
const PATHSPEC_BUDGET = 6000;

/** Split `paths` so every resulting argv stays under the OS command-length limit. */
function chunkPathspec(paths: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const path of paths) {
    if (current.length > 0 && size + path.length + 1 > PATHSPEC_BUDGET) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(path);
    size += path.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Unified diff from `mergeBase` to the **working tree**, optionally restricted
 * to `paths`, for the five verify gates. Matches what `changedFiles` reports,
 * except that untracked files are invisible to `git diff` and so never appear.
 *
 * A wide PR would overflow the OS argument limit (E2BIG / the 32k CreateProcess
 * ceiling on Windows) if every path went into one argv, so the pathspec is
 * chunked and the per-chunk patches are concatenated — consumers split a unified
 * diff on `diff --git` headers anyway, so the join is lossless. Binary patches
 * are deliberately not requested: the gates parse the patch as source text.
 */
export async function branchDiffText(
  rootPath: string,
  mergeBase: string,
  paths: string[] = [],
): Promise<string | null> {
  const base = ["diff", "--no-ext-diff", "--no-textconv", mergeBase];
  if (paths.length === 0) return git(rootPath, base);
  const parts: string[] = [];
  for (const chunk of chunkPathspec(paths)) {
    const out = await git(rootPath, [...base, "--", ...chunk]);
    if (out) parts.push(out);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Contents of `relPath` at `ref`, or null when the path did not exist there
 * (i.e. the file was added on this branch). `relPath` is repo-relative with
 * forward slashes (as `changedFiles` reports).
 */
export async function fileAtRef(
  rootPath: string,
  ref: string,
  relPath: string,
): Promise<string | null> {
  return git(rootPath, ["show", `${ref}:${relPath}`]);
}
