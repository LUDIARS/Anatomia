/**
 * src/knowledge/entrypoint/projection.ts — The `entrypoint-graph.json` artifact.
 *
 * Canonical JSON keyed by the definition fingerprint: the same analysis always
 * writes the same bytes, so a re-sync that changed nothing rewrites nothing.
 *
 * SRP: artifact shaping only.
 */

import { canonicalJson } from "../canonical-json.js";
import type { GeneratedArtifact } from "../types.js";
import type { CanonicalEntryPointGraph, EntryPointGraphManifest } from "./types.js";

export function buildEntryPointProjection(
  canonical: CanonicalEntryPointGraph,
  knowledgeHead: string,
): { manifest: EntryPointGraphManifest; artifacts: GeneratedArtifact[] } {
  const manifest: EntryPointGraphManifest = {
    schemaVersion: 1,
    projectionSchema: 1,
    projectId: canonical.projectId,
    knowledgeHead,
    sourceRevision: canonical.sourceRevision,
    definitionFingerprint: canonical.definitionFingerprint,
    entries: canonical.graph.entries,
    graphNodes: canonical.graph.nodes,
    graphEdges: canonical.graph.edges,
    unrooted: canonical.graph.unrooted,
    diagnostics: canonical.graph.diagnostics,
  };
  return {
    manifest,
    artifacts: [{
      path: "entrypoint-graph.json",
      content: canonicalJson(manifest) + "\n",
      entityId: `entrypoint-graph:${canonical.projectId}`,
    }],
  };
}
