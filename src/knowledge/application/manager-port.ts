import type { ProjectManager } from "../../project/manager.js";
import type { KnowledgeProjectPort } from "./port.js";

// @implements SPEC-knowledge-adapter-migration

export function knowledgePortFromManager(manager: ProjectManager, requestedId?: string): KnowledgeProjectPort {
  const projectId = manager.resolveId(requestedId);
  const project = manager.get(projectId)!;
  return {
    project,
    context: () => manager.getContext(projectId),
    fingerprint: () => manager.fingerprint(projectId),
    refresh: async () => {
      manager.cache.invalidate(projectId);
      return manager.analyzeProject(projectId);
    },
  };
}
