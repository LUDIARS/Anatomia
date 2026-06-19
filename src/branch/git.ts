/**
 * src/branch/git.ts — Minimal git access for branch-diff analysis.
 *
 * SRP: shells out to `git` and returns plain data. No parsing, no diff
 * classification, no HTTP. Used by branch/diff.ts to discover what a branch
 * changed relative to its fork point and to read the base version of a file.
 *
 * Everything here degrades gracefully: a non-git directory, a missing ref, or
 * an absent file resolves to null/[]/false rather than throwing, so the
 * branch-diff feature is a no-op (not an error) outside a git checkout.
 */

import { execFile } from "node:child_process";
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
