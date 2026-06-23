/**
 * src/adapters/web/context.ts — WebContextSource abstraction.
 *
 * Bridges single-AnalysisContext (legacy) and ProjectManager (multi-project)
 * modes behind a uniform interface used by the HTTP route modules.
 *
 * SRP: context resolution only. No HTTP logic, no analysis.
 */

import { ProjectManager } from "../../project/manager.js";
import { summarize } from "../../project/cache.js";
import type { SummaryCounts } from "../../project/cache.js";
import type { AnalysisContext } from "../../core.js";
import type { Project } from "../../project/types.js";

/** Uniform context-resolution interface shared by all web route modules. */
export interface WebContextSource {
  /** Resolve the AnalysisContext for an optional project id. */
  resolve(projectId?: string): Promise<AnalysisContext>;
  /**
   * First-view summary counts for a project. Cheaper than resolve(): served
   * from the persisted snapshot when the source is unchanged, so the project
   * list repaints without forcing a full re-analysis after a restart.
   * `{ stale: true }` returns the snapshot immediately and revalidates in the
   * background (skips even the fingerprint walk).
   */
  summary(projectId?: string, opts?: { stale?: boolean }): Promise<SummaryCounts>;
  /** All registered projects (or a synthetic single-entry list). */
  projects(): Project[];
  /** The currently selected/default project id, or null. */
  selected(): string | null;
  /** The source fingerprint for a project (for content-keyed derived caches). */
  fingerprint(projectId?: string): Promise<string>;
  /**
   * Resolve a fingerprint-keyed derived render artifact (vis-data etc),
   * building it from the context only on a cache miss. After a restart the
   * persisted artifact is served straight from disk WITHOUT re-analysis, so
   * opening the graph view never re-parses the whole repo.
   */
  cachedArtifact<T>(
    projectId: string | undefined,
    name: string,
    build: (ctx: AnalysisContext) => Promise<T>,
  ): Promise<T>;
}

/**
 * Wrap either a bare AnalysisContext (legacy) or a ProjectManager behind a
 * WebContextSource. In legacy mode the `projectId` argument to resolve() is
 * ignored and the single context is always returned.
 */
export function webContextSourceFrom(
  src: AnalysisContext | ProjectManager,
): WebContextSource {
  if (src instanceof ProjectManager) {
    return {
      resolve: (projectId?: string) => src.getContext(projectId),
      summary: (projectId?: string, opts?: { stale?: boolean }) =>
        src.summary(projectId, opts),
      projects: () => src.list(),
      selected: () => src.selected,
      fingerprint: (projectId?: string) => src.fingerprint(projectId),
      cachedArtifact: (projectId, name, build) =>
        src.cachedArtifact(projectId, name, build),
    };
  }

  // Legacy single context: synthesise a one-entry "registry" view.
  const single: Project = {
    id: "default",
    name: "default",
    rootPath: src.repoPath,
    addedAt: "",
  };
  return {
    resolve: async () => src,
    // Legacy single context: no snapshot/fingerprint, so SWR has nothing to
    // serve stale — always summarise the in-memory context directly.
    summary: async () => summarize(src),
    projects: () => [single],
    selected: () => "default",
    fingerprint: async () => "nofp",
    // Legacy single-context mode has no project home/fingerprint to key a disk
    // cache on, so build fresh each call. This is the one-off CLI/export path,
    // not the warm multi-project server where the cache matters.
    cachedArtifact: async (_projectId, _name, build) => build(src),
  };
}
