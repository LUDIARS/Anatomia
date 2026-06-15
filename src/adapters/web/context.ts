/**
 * src/adapters/web/context.ts — WebContextSource abstraction.
 *
 * Bridges single-AnalysisContext (legacy) and ProjectManager (multi-project)
 * modes behind a uniform interface used by the HTTP route modules.
 *
 * SRP: context resolution only. No HTTP logic, no analysis.
 */

import { ProjectManager } from "../../project/manager.js";
import type { AnalysisContext } from "../../core.js";
import type { Project } from "../../project/types.js";

/** Uniform context-resolution interface shared by all web route modules. */
export interface WebContextSource {
  /** Resolve the AnalysisContext for an optional project id. */
  resolve(projectId?: string): Promise<AnalysisContext>;
  /** All registered projects (or a synthetic single-entry list). */
  projects(): Project[];
  /** The currently selected/default project id, or null. */
  selected(): string | null;
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
      projects: () => src.list(),
      selected: () => src.selected,
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
    projects: () => [single],
    selected: () => "default",
  };
}
