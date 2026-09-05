/**
 * src/project/config-paths.ts — Registry config dirs that still exist on disk.
 *
 * The shared registry (`.anatomia/projects.json`) is long-lived while the dirs
 * it points at are not: a project registered from a worktree keeps an
 * `ontologyDir` / `specDirs` entry after that worktree is deleted. Feeding a
 * vanished dir to `analyze()` made the ontology load throw ("unable to read
 * ontology directory") and the WHOLE domain phase drop — a repo that commits 24
 * domains reported zero, and `where` / supply answered with an empty
 * `existingDomains` as if the repo had never declared anything.
 *
 * A dangling config path is a STALE POINTER, not a statement that the repo has
 * no domains, so the right recovery is to ignore it and let the caller's own
 * fallback chain (the repo's committed `spec/domains`) run. That is a different
 * situation from a dir that exists but holds a malformed def — which still
 * fails loudly. The drop is warned once per path so a stale registry entry is
 * visible instead of looking like a silently domain-less repo (RULE_CODE §7).
 *
 * SRP: existence filtering of a Project's configured dirs only. The fallback
 * order (committed ontology dir → repo default) stays with each caller.
 */

import { statSync } from "node:fs";
import type { Project } from "./types.js";
import { vgWrite } from "../obs/vestigium.js";

/** Paths already reported, so a warm server warns once instead of per request. */
const warned = new Set<string>();

/** True when `path` is a directory that exists right now. */
function isExistingDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Warn (once per path) that a configured dir is gone and is being ignored. */
function warnStale(projectId: string, field: string, path: string): void {
  const key = `${projectId}\0${field}\0${path}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(
    `[anatomia] project "${projectId}": ${field} の設定先は存在しません。` +
      `レジストリの設定を無視してリポジトリ既定 (spec/domains) にフォールバックします。`,
  );
  // Do not copy an absolute local path (often containing a user name) into the
  // shared observability transcript. Project + field identify the stale entry.
  vgWrite("warn", "project config dir missing", { project: projectId, field });
}

/**
 * The project's configured ontology dir when it still exists, else undefined so
 * the caller falls back to the repo's committed domain dir.
 */
export function effectiveOntologyDir(project: Project): string | undefined {
  const dir = project.ontologyDir;
  if (dir === undefined) return undefined;
  if (isExistingDir(dir)) return dir;
  warnStale(project.id, "ontologyDir", dir);
  return undefined;
}

/**
 * The project's configured spec dirs, minus the ones that vanished. An entry
 * that lost every dir returns undefined so spec resolution falls back to
 * auto-detection instead of analysing against an empty spec source.
 */
export function effectiveSpecDirs(project: Project): string[] | undefined {
  const dirs = project.specDirs;
  if (dirs === undefined) return undefined;
  const kept = dirs.filter((dir) => {
    if (isExistingDir(dir)) return true;
    warnStale(project.id, "specDirs", dir);
    return false;
  });
  return kept.length > 0 ? kept : undefined;
}

/** Config dirs that feed the analysis fingerprint, minus the vanished ones. */
export function effectiveConfigDirs(project: Project): string[] {
  const dirs: string[] = [];
  const ontologyDir = effectiveOntologyDir(project);
  if (ontologyDir) dirs.push(ontologyDir);
  dirs.push(...(effectiveSpecDirs(project) ?? []));
  if (project.knowledgeWriteRoot) dirs.push(project.knowledgeWriteRoot);
  return dirs;
}
