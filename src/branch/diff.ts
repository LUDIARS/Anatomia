/**
 * src/branch/diff.ts — Branch-diff analysis.
 *
 * Produces analysis info for ONLY the code a branch changed relative to its
 * fork point, while staying anchored to the project's full analysis: the
 * returned `anchors` are AnchorIds that already exist in the project graph, so
 * the panel can either show the diff on its own or filter the main graph down
 * to just the diff (DESIGN: the cache/graph is the data structure; a branch
 * diff is a *view* over it, never a separate parse of the whole repo).
 *
 * How it works:
 *   - git (branch/git.ts) finds the merge-base and the changed source files;
 *   - the "after" side reuses the already-analyzed working-tree FunctionNodes
 *     from the AnalysisContext (no re-parse of unchanged files);
 *   - the "before" side is parsed from each file's content at the merge-base;
 *   - dag/diff.ts classifies functions added / changed / removed by AnchorId.
 *
 * SRP: orchestrate git + parse(before) + diffFiles. No HTTP, no graph build, no
 * vis encoding. Outside a git repo (or with no base) it returns
 * `{ available: false, reason }` rather than throwing.
 */

import { extname, join, relative } from "node:path";
import { parse } from "../dag/parser.js";
import { extractFunctions } from "../dag/extract.js";
import { normalize } from "../dag/normalize.js";
import { assignAnchorId } from "../dag/hash.js";
import { diffFiles } from "../dag/diff.js";
import { langFor } from "../core.js";
import type { AnalysisContext } from "../core.js";
import type { FileNode, FunctionNode } from "../types.js";
import {
  isGitRepo,
  resolveBase,
  changedFiles,
  fileAtRef,
  currentBranch,
  headSha,
} from "./git.js";

/** Source extensions whose function-level diff is reported. */
const SOURCE_EXTS = new Set([".cpp", ".h", ".cs", ".ts", ".tsx"]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BranchDiffFn {
  /** Current AnchorId (null only for removed functions, which no longer exist). */
  anchor: string | null;
  name: string;
  line: number;
}

export type FileChangeStatus = "added" | "deleted" | "modified";

export interface BranchDiffFile {
  /** Repo-relative path (forward slashes). */
  path: string;
  status: FileChangeStatus;
  added: BranchDiffFn[];
  changed: BranchDiffFn[];
  removed: BranchDiffFn[];
}

export interface BranchDiff {
  available: boolean;
  /** Present when available === false (e.g. "not a git repository"). */
  reason?: string;
  /** Chosen base ref label (e.g. "origin/main"). */
  base?: string;
  /** Merge-base commit between base and HEAD. */
  mergeBase?: string;
  branch?: string | null;
  head?: string | null;
  generatedAt: string;
  files: BranchDiffFile[];
  /**
   * AnchorIds that exist in the current project graph and that this branch
   * added or changed — the set the panel filters the main graph down to.
   */
  anchors: { added: string[]; changed: string[]; all: string[] };
  summary: {
    filesChanged: number;
    functionsAdded: number;
    functionsChanged: number;
    functionsRemoved: number;
  };
}

export interface BranchDiffOptions {
  /** Explicit base ref; defaults to the first of origin/main, main, …. */
  base?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSourcePath(relPath: string): boolean {
  const ext = extname(relPath).toLowerCase();
  if (!SOURCE_EXTS.has(ext)) return false;
  if (relPath.endsWith(".d.ts")) return false;
  return true;
}

function toFn(fn: FunctionNode): BranchDiffFn {
  return { anchor: fn.id, name: fn.name, line: fn.sourceRange.start.line };
}

/**
 * Parse one file's source into a FileNode with hashed functions, then free the
 * tree. `absPath` MUST be the same absolute path analyze() used for the working
 * tree: AnchorId folds the (slash-normalized) file path into its hash, so the
 * before/after anchors only line up when both sides hash the same path.
 */
async function fileNodeFromSource(
  absPath: string,
  src: string,
): Promise<FileNode> {
  const tree = await parse(src, langFor(absPath));
  try {
    const fns = extractFunctions(tree, src, absPath);
    for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst));
    return { path: absPath, hash: null, functions: fns };
  } finally {
    // Free the WASM-owned tree: diffFiles only needs id/name/signature.
    tree.delete();
  }
}

const EMPTY_FILE = (relPath: string): FileNode => ({
  path: relPath,
  hash: null,
  functions: [],
});

function notAvailable(reason: string, generatedAt: string): BranchDiff {
  return {
    available: false,
    reason,
    generatedAt,
    files: [],
    anchors: { added: [], changed: [], all: [] },
    summary: {
      filesChanged: 0,
      functionsAdded: 0,
      functionsChanged: 0,
      functionsRemoved: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// computeBranchDiff
// ---------------------------------------------------------------------------

/**
 * Compute the function-level branch diff for an analyzed project.
 *
 * The "after" functions come from `ctx` (the warm full analysis), so unchanged
 * files are never re-parsed. Only the base version of each changed file is
 * parsed here.
 */
export async function computeBranchDiff(
  ctx: AnalysisContext,
  opts: BranchDiffOptions = {},
): Promise<BranchDiff> {
  const root = ctx.repoPath;
  const generatedAt = new Date().toISOString();

  if (!(await isGitRepo(root))) {
    return notAvailable("not a git repository", generatedAt);
  }
  const resolved = await resolveBase(root, opts.base);
  if (!resolved) {
    return notAvailable(
      "no base branch found (looked for origin/main, main, origin/master, master)",
      generatedAt,
    );
  }

  const [branch, head] = await Promise.all([currentBranch(root), headSha(root)]);
  const changed = await changedFiles(root, resolved.mergeBase);

  // Index the working-tree analysis by repo-relative path so unchanged files
  // are reused as the "after" side without re-parsing.
  const afterByRel = new Map<string, FileNode>();
  for (const f of ctx.files) {
    afterByRel.set(relative(root, f.path).replace(/\\/g, "/"), f);
  }

  const files: BranchDiffFile[] = [];
  const addedAnchors: string[] = [];
  const changedAnchors: string[] = [];

  for (const relPath of changed) {
    if (!isSourcePath(relPath)) continue;

    const after = afterByRel.get(relPath) ?? null;
    const baseSrc = await fileAtRef(root, resolved.mergeBase, relPath);

    // Determine file status from presence on each side.
    const existedBefore = baseSrc !== null;
    const existsAfter = after !== null;
    if (!existedBefore && !existsAfter) continue; // nothing to report

    const status: FileChangeStatus = !existedBefore
      ? "added"
      : !existsAfter
        ? "deleted"
        : "modified";

    // The before side must hash the SAME absolute path analyze() used for the
    // working-tree version (AnchorId folds the file path in) — otherwise every
    // function would look "changed".
    const absPath = join(root, relPath);
    const beforeNode = existedBefore
      ? await fileNodeFromSource(absPath, baseSrc as string)
      : EMPTY_FILE(absPath);
    const afterNode = after ?? EMPTY_FILE(absPath);

    const d = diffFiles(beforeNode, afterNode);
    const fileEntry: BranchDiffFile = {
      path: relPath,
      status,
      added: d.added.map(toFn),
      changed: d.changed.map(([, a]) => toFn(a)),
      removed: d.removed.map((b) => ({ anchor: null, name: b.name, line: b.sourceRange.start.line })),
    };
    if (
      fileEntry.added.length === 0 &&
      fileEntry.changed.length === 0 &&
      fileEntry.removed.length === 0
    ) {
      continue; // changed bytes but no function-level delta (e.g. comments)
    }
    files.push(fileEntry);

    for (const fn of fileEntry.added) if (fn.anchor) addedAnchors.push(fn.anchor);
    for (const fn of fileEntry.changed) if (fn.anchor) changedAnchors.push(fn.anchor);
  }

  const added = [...new Set(addedAnchors)];
  const changedA = [...new Set(changedAnchors)];
  const all = [...new Set([...added, ...changedA])];

  return {
    available: true,
    base: resolved.ref,
    mergeBase: resolved.mergeBase,
    branch,
    head,
    generatedAt,
    files,
    anchors: { added, changed: changedA, all },
    summary: {
      filesChanged: files.length,
      functionsAdded: files.reduce((n, f) => n + f.added.length, 0),
      functionsChanged: files.reduce((n, f) => n + f.changed.length, 0),
      functionsRemoved: files.reduce((n, f) => n + f.removed.length, 0),
    },
  };
}
