import { canonicalJson } from "./canonical-json.js";
import type { GeneratedArtifact, KnowledgeGraph } from "./types.js";

/** Deterministic legacy JSON projections; callers persist them through the ownership writer. */
export function compatibilityArtifacts(state: KnowledgeGraph, projectId: string): GeneratedArtifact[] {
  const domains = [...state.nodes.values()]
    .filter((node) => node.kind === "domain")
    .sort((a, b) => a.id.localeCompare(b.id));
  const scenes = [...state.nodes.values()]
    .filter((node) => node.kind === "scene")
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...state.edges.values()].sort((a, b) => a.id.localeCompare(b.id));
  return [
    {
      path: `compat/${projectId}.taxonomy.json`,
      entityId: `projection:${projectId}/taxonomy`,
      content: canonicalJson({ schemaVersion: 1, knowledgeHead: state.head, domains, edges }) + "\n",
    },
    {
      path: `compat/${projectId}.domain.json`,
      entityId: `projection:${projectId}/domains`,
      content: canonicalJson({ schemaVersion: 1, knowledgeHead: state.head, domains }) + "\n",
    },
    {
      path: `compat/${projectId}.screens.json`,
      entityId: `projection:${projectId}/screens`,
      content: canonicalJson({ schemaVersion: 1, knowledgeHead: state.head, screens: scenes }) + "\n",
    },
    {
      path: `compat/${projectId}.scenes.json`,
      entityId: `projection:${projectId}/scenes`,
      content: canonicalJson({ schemaVersion: 1, knowledgeHead: state.head, scenes, edges }) + "\n",
    },
  ];
}
