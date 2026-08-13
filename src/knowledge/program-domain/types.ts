import type { ProgramDomainGraph } from "../../domains/program/types.js";
import type { KnowledgeEdge, KnowledgeNode } from "../types.js";

export interface CanonicalProgramDomainGraph extends ProgramDomainGraph {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
}

export interface ProgramDomainManifest {
  schemaVersion: 1;
  projectionSchema: 1;
  projectId: string;
  knowledgeHead: string;
  sourceRevision: string;
  definitionFingerprint: string;
  domains: ProgramDomainGraph["domains"];
  diagnostics: ProgramDomainGraph["diagnostics"];
}
