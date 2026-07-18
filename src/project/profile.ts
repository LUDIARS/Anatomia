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

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
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
