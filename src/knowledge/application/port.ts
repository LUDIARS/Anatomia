import type { AnalysisContext } from "../../core.js";
import type { Project } from "../../project/types.js";

export interface KnowledgeProjectPort {
  project: Project;
  context(): Promise<AnalysisContext>;
  fingerprint(): Promise<string>;
  refresh(): Promise<AnalysisContext>;
}
