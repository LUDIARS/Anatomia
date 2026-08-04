import { existsSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

/**
 * The write-root inputs only. Structural rather than importing `Project`, so the
 * knowledge layer does not take a dependency on the project layer just to read
 * three fields (a registered `Project` satisfies this shape as-is).
 */
export interface KnowledgeWriteRootInput {
  rootPath: string;
  knowledgeWriteRoot?: string;
  specDirs?: string[];
}

function canonical(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  // relative() across Windows drives returns an absolute path ("D:\\x"), which
  // starts with neither ".." nor a separator — isAbsolute is the only safe test.
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function validateWriteRoot(projectRoot: string, candidate: string): string {
  const root = canonical(projectRoot);
  const writeRoot = canonical(candidate);
  if (!isInside(root, writeRoot)) {
    throw new Error(`knowledgeWriteRoot must be inside project root: ${writeRoot}`);
  }
  return writeRoot;
}

/** Resolve one repository-owned write root without selecting arbitrarily among read roots. */
export function resolveKnowledgeWriteRoot(project: KnowledgeWriteRootInput): string {
  if (project.knowledgeWriteRoot?.trim()) {
    return validateWriteRoot(project.rootPath, project.knowledgeWriteRoot);
  }

  const conventional = resolve(project.rootPath, "spec");
  if (existsSync(conventional)) return validateWriteRoot(project.rootPath, conventional);

  const candidates = [...new Set((project.specDirs ?? []).map(canonical))]
    .filter((path) => isInside(canonical(project.rootPath), path))
    .filter((path) => basename(path).toLowerCase() === "spec");
  if (candidates.length === 1) return validateWriteRoot(project.rootPath, candidates[0]);
  if (candidates.length > 1) {
    throw new Error("knowledgeWriteRoot is ambiguous; configure one explicit write root");
  }
  throw new Error("knowledgeWriteRoot is not configured and <project>/spec is unavailable");
}
