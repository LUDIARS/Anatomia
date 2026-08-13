import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeGeneratedArtifacts, type GeneratedWriteResult } from "../artifact-writer.js";
import { canonicalJson } from "../canonical-json.js";
import { replayKnowledgeLog, writeKnowledgeTransaction } from "../log.js";
import type { KnowledgeTransaction } from "../types.js";
import { buildProgramDomainProjection } from "./projection.js";
import type { CanonicalProgramDomainGraph, ProgramDomainManifest } from "./types.js";

export interface ProgramDomainSyncRequest { graph: CanonicalProgramDomainGraph; knowledgeLogPath: string; generatedRoot: string; expectedHead: string | null; readCurrentSourceRevision?: () => Promise<string> }
export interface ProgramDomainSyncResult { transaction: KnowledgeTransaction | null; knowledgeHead: string; canonicalChanged: boolean; manifest: ProgramDomainManifest; canonicalCommitted: true; projectionsStale: boolean; projection: GeneratedWriteResult | null; projectionError: string | null }
async function readKnowledge(path: string) { try { return replayKnowledgeLog(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return replayKnowledgeLog(""); throw error; } }

function nodesToReplace(
  graph: CanonicalProgramDomainGraph,
  state: Awaited<ReturnType<typeof readKnowledge>>,
  owner: string,
) {
  return graph.nodes.filter((node) => {
    const existing = state.nodes.get(node.id);
    if (existing && existing.kind !== node.kind) {
      throw new Error(`program-domain node ${node.id} conflicts with ${existing.kind}`);
    }
    // Code symbols are shared evidence records. The program-domain derived set
    // owns its domains and relations, but must not overwrite a richer symbol
    // record created by the business-domain or scene pipelines.
    return !existing || existing.data?.derivedOwner === owner || node.kind !== "code-symbol";
  });
}

function sameDerivedSet(
  owner: string,
  state: Awaited<ReturnType<typeof readKnowledge>>,
  nodes: CanonicalProgramDomainGraph["nodes"],
  edges: CanonicalProgramDomainGraph["edges"],
): boolean {
  const currentNodes = [...state.nodes.values()]
    .filter((node) => node.data?.derivedOwner === owner)
    .sort((left, right) => left.id.localeCompare(right.id));
  const currentEdges = [...state.edges.values()]
    .filter((edge) => edge.evidence?.derivedOwner === owner)
    .sort((left, right) => left.id.localeCompare(right.id));
  return canonicalJson(currentNodes) === canonicalJson(nodes)
    && canonicalJson(currentEdges) === canonicalJson(edges);
}

/** Sync using the exact scene code-sync transaction pattern. */
export async function syncCanonicalProgramDomains(request: ProgramDomainSyncRequest): Promise<ProgramDomainSyncResult> {
  if (request.readCurrentSourceRevision && await request.readCurrentSourceRevision() !== request.graph.sourceRevision) throw new Error("program-domain source revision changed before sync");
  const owner = `program-domain:${request.graph.projectId}`; const before = await readKnowledge(request.knowledgeLogPath);
  if (before.head !== request.expectedHead) throw new Error(`program-domain sync head conflict: expected ${request.expectedHead}, got ${before.head}`);
  const nodes = nodesToReplace(request.graph, before, owner);
  const digest = createHash("sha256").update(canonicalJson({ fingerprint: request.graph.definitionFingerprint, head: request.expectedHead }), "utf8").digest("hex").slice(0, 24);
  const canonicalChanged = before.head === null || !sameDerivedSet(owner, before, nodes, request.graph.edges);
  const transaction = canonicalChanged ? await writeKnowledgeTransaction(request.knowledgeLogPath, { transactionId: `tx:program-domain-sync/${digest}`, analysisSnapshotId: `program-domain:${request.graph.definitionFingerprint}`, sourceRevisions: { spec: null, code: request.graph.sourceRevision, trace: null }, origin: "code-sync", operations: [{ op: "replace-derived-set", owner, nodes, edges: request.graph.edges }], provenance: { proposalIds: [], approval: { kind: "automatic", reviewRef: null }, generatorSchema: 1 } }, request.expectedHead) : null;
  const knowledgeHead = transaction?.transactionHash ?? before.head!; const projected = buildProgramDomainProjection(request.graph, knowledgeHead);
  try { const projection = await writeGeneratedArtifacts({ generatedRoot: request.generatedRoot, artifacts: projected.artifacts, knowledgeHead, sourceRevision: request.graph.sourceRevision, sourceFingerprint: request.graph.definitionFingerprint, generatorSchema: 1, projectionSchema: 1, readCurrentKnowledgeHead: async () => (await readKnowledge(request.knowledgeLogPath)).head, readCurrentSourceRevision: request.readCurrentSourceRevision }); return { transaction, knowledgeHead, canonicalChanged, manifest: projected.manifest, canonicalCommitted: true, projectionsStale: false, projection, projectionError: null }; }
  catch (error) { return { transaction, knowledgeHead, canonicalChanged, manifest: projected.manifest, canonicalCommitted: true, projectionsStale: true, projection: null, projectionError: error instanceof Error ? error.message : String(error) }; }
}
