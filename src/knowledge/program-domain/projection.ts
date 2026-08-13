import { canonicalJson } from "../canonical-json.js";
import type { GeneratedArtifact } from "../types.js";
import type { CanonicalProgramDomainGraph, ProgramDomainManifest } from "./types.js";

/** Deterministic program-domain artifact; Kuzu reads the same canonical log records. */
export function buildProgramDomainProjection(graph: CanonicalProgramDomainGraph, knowledgeHead: string): { manifest: ProgramDomainManifest; artifacts: GeneratedArtifact[] } {
  const manifest: ProgramDomainManifest = { schemaVersion: 1, projectionSchema: 1, projectId: graph.projectId, knowledgeHead, sourceRevision: graph.sourceRevision, definitionFingerprint: graph.definitionFingerprint, domains: graph.domains, diagnostics: graph.diagnostics };
  return { manifest, artifacts: [{ path: "program-domains.json", content: canonicalJson(manifest) + "\n", entityId: `program-domains:${graph.projectId}` }] };
}
