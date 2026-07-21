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
 * Errors that genuinely mean "this marker is absent": the path (or a parent
 * component) does not exist. Anything else — EACCES/EPERM (unreadable),
 * EIO/EBUSY (a failing/mounted filesystem) — is NOT evidence of absence, and
 * swallowing it would misclassify the project (e.g. an unreadable Unity marker
 * would fall through to the `generic` profile and "succeed" with the wrong
 * framework analysis). Those are re-thrown so the caller surfaces them.
 */
function isAbsentError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    if (isAbsentError(err)) return false;
    throw err;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (err) {
    if (isAbsentError(err)) return false;
    throw err;
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
