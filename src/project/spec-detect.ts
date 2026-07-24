/**
 * src/project/spec-detect.ts — spec-source probing + auto-detection.
 *
 * Not every repo keeps its spec where the LUDIARS layout expects (`spec/` +
 * markdown under the code root). When a project has no configured `specDirs`
 * and its root contains no markdown at all, this module looks for the spec
 * tree in the places a non-conforming layout actually puts it — ancestor
 * directories' `spec`/`docs`-style folders — so the manager can auto-configure
 * `specDirs` and proceed, or report "no spec found" to the user.
 *
 * Guard rails:
 *   - A root that IS a git repo root gets no ancestor probing: its spec should
 *     live inside it, and its parent's folders belong to *other* projects
 *     (e.g. a workspace dir full of sibling clones).
 *   - Ancestor probing walks up only until (and including) the nearest git
 *     root, capped at MAX_ANCESTOR_HOPS, so a deep subdir still finds the
 *     repo-level spec without ever escaping the repository.
 *
 * SRP: filesystem probing + candidate ranking only. No registry writes (the
 * manager persists), no analysis.
 */

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { collectFilesByExt, readGitignoreDirs, EXCLUDE_DIRS } from "../fs/walk.js";

/** Directory names a non-conforming layout plausibly keeps its spec in. */
const SPEC_DIR_CANDIDATES = ["spec", "specs", "doc", "docs", "design"];

/** How many ancestors to probe when the root is not itself a git root. */
const MAX_ANCESTOR_HOPS = 3;

const MD_EXTS = new Set([".md"]);

/** True when the directory subtree contains at least one markdown file. */
export async function hasMarkdownSources(root: string): Promise<boolean> {
  const gitDirs = await readGitignoreDirs(root);
  const files = await collectFilesByExt(root, MD_EXTS, new Set([...EXCLUDE_DIRS, ...gitDirs]));
  return files.length > 0;
}

/**
 * Find candidate spec directories for a root that has no markdown of its own.
 * Returns absolute paths, deterministic order (nearest ancestor first, then
 * candidate-name order); empty when nothing plausible exists.
 */
export async function detectSpecDirCandidates(root: string): Promise<string[]> {
  // A git root carries its own spec; never propose siblings from the workspace.
  if (existsSync(join(root, ".git"))) return [];

  const found: string[] = [];
  let dir = root;
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    for (const name of SPEC_DIR_CANDIDATES) {
      const candidate = join(parent, name);
      if (!(await isDir(candidate))) continue;
      if (await hasMarkdownSources(candidate)) found.push(candidate);
    }
    // Stop at the repository boundary (inclusive: its candidates were probed).
    if (existsSync(join(parent, ".git"))) break;
    dir = parent;
  }
  return found;
}

async function isDir(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

/** Where a project's spec clauses come from, as resolved by ensureSpecConfig. */
export interface SpecConfigStatus {
  /**
   * configured — user-set specDirs;  auto — specDirs auto-detected (persisted);
   * root — markdown under rootPath, default behaviour needs no config;
   * missing — nothing found: analysis proceeds without spec linkage and the
   * user should point specDirs at the spec tree (CLI `project spec` / dashboard).
   */
  source: "configured" | "auto" | "root" | "missing";
  /** The dirs in effect (absent for root/missing). */
  dirs?: string[];
}
