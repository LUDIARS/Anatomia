// @implements SPEC-knowledge-quality-report

export interface KnowledgeIntegrationScenario {
  id: "spec-only" | "code-only" | "mixed" | "renamed" | "hierarchy-conflict" | "scene-rename" | "trace-enrichment";
  expected: string;
}

/** Required T69 scenarios; these are a catalog, not executable fixtures or measured samples. */
export const KNOWLEDGE_INTEGRATION_SCENARIOS: KnowledgeIntegrationScenario[] = [
  { id: "spec-only", expected: "domain proposal remains missing until code assignment" },
  { id: "code-only", expected: "exact CodeSymbol remains unassigned with evidence" },
  { id: "mixed", expected: "approved domain owns exact spec and code nodes" },
  { id: "renamed", expected: "durable identity is preserved through alias evidence" },
  { id: "hierarchy-conflict", expected: "multiple parent and cycle validation reject apply" },
  { id: "scene-rename", expected: "native identity remains stable while label changes" },
  { id: "trace-enrichment", expected: "observation attaches only to an existing canonical scene" },
];
