/**
 * Project-level analysis profile.
 *
 * SRP: classify a repository from its on-disk project markers and source-file
 * extensions. Framework-specific analysis consumes this profile instead of
 * guessing from method names alone.
 */

import { stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

export type ProjectKind = "generic" | "unity";
export type GraphViewMode = "function" | "class";

export interface ProjectProfile {
  kind: ProjectKind;
  defaultGraphView: GraphViewMode;
}

const CLASS_CENTRIC_EXTS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
  ".cs", ".java",
]);
const FUNCTION_CENTRIC_EXTS = new Set([".ts", ".tsx", ".go"]);

/** Pick the initial graph view from the dominant supported language family. */
export function defaultGraphViewForPaths(paths: readonly string[]): GraphViewMode {
  let classCentric = 0;
  let functionCentric = 0;
  for (const path of paths) {
    const ext = extname(path).toLowerCase();
    if (CLASS_CENTRIC_EXTS.has(ext)) classCentric++;
    else if (FUNCTION_CENTRIC_EXTS.has(ext)) functionCentric++;
  }
  return classCentric > 0 && classCentric >= functionCentric ? "class" : "function";
}

/**
 * ENOENT/ENOTDIR mean the marker genuinely isn't there; any other errno
 * (EACCES/EIO/ELOOP/EMFILE/…) is a real filesystem fault that must NOT be
 * silently read as "marker absent" — otherwise a permission/IO error on a real
 * Unity tree would misclassify it as generic. On such a fault we surface a
 * warning (matching the analyze/spec-link convention of warn-and-continue) so
 * the failed probe is visible instead of swallowed, and still report "absent"
 * for this marker (detectProjectKind's return type has no inconclusive state).
 */
function isMissingError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    if (!isMissingError(err)) {
      console.warn(`[anatomia/project] Unity marker probe failed for ${path}: ${String(err)}`);
    }
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (err) {
    if (!isMissingError(err)) {
      console.warn(`[anatomia/project] Unity marker probe failed for ${path}: ${String(err)}`);
    }
    return false;
  }
}

/** Require both canonical markers before enabling Unity-only analysis. */
export async function detectProjectKind(repoPath: string): Promise<ProjectKind> {
  const root = resolve(repoPath);
  const candidates: string[] = [];
  let candidate = root;
  while (true) {
    candidates.push(candidate);
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }

  for (const candidate of candidates) {
    const [hasAssets, hasProjectVersion] = await Promise.all([
      isDirectory(join(candidate, "Assets")),
      isFile(join(candidate, "ProjectSettings", "ProjectVersion.txt")),
    ]);
    if (hasAssets && hasProjectVersion) return "unity";
  }
  return "generic";
}

export async function buildProjectProfile(
  repoPath: string,
  sourcePaths: readonly string[],
): Promise<ProjectProfile> {
  return {
    kind: await detectProjectKind(repoPath),
    defaultGraphView: defaultGraphViewForPaths(sourcePaths),
  };
}
