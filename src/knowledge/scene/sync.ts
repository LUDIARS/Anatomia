import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeGeneratedArtifacts, type GeneratedWriteResult } from "../artifact-writer.js";
import { canonicalJson } from "../canonical-json.js";
import { replayKnowledgeLog, writeKnowledgeTransaction } from "../log.js";
import type { KnowledgeTransaction } from "../types.js";
import { buildSceneProjection } from "./projection.js";
import type { CanonicalSceneGraph, SceneManifest } from "./types.js";

export interface SceneSyncRequest {
  graph: CanonicalSceneGraph;
  knowledgeLogPath: string;
  generatedRoot: string;
  expectedHead: string | null;
  readCurrentSourceRevision?: () => Promise<string>;
}

export interface SceneSyncResult {
  transaction: KnowledgeTransaction | null;
  knowledgeHead: string;
  canonicalChanged: boolean;
  manifest: SceneManifest;
  canonicalCommitted: true;
  projectionsStale: boolean;
  projection: GeneratedWriteResult | null;
  projectionError: string | null;
}

async function readKnowledge(path: string) {
  try { return replayKnowledgeLog(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return replayKnowledgeLog("");
    throw error;
  }
}

function sameDerivedSet(owner: string, current: Awaited<ReturnType<typeof readKnowledge>>, graph: CanonicalSceneGraph): boolean {
  const nodes = [...current.nodes.values()]
    .filter((node) => node.data?.derivedOwner === owner)
    .sort((left, right) => left.id.localeCompare(right.id));
  const edges = [...current.edges.values()]
    .filter((edge) => edge.evidence?.derivedOwner === owner)
    .sort((left, right) => left.id.localeCompare(right.id));
  return canonicalJson(nodes) === canonicalJson(graph.nodes)
    && canonicalJson(edges) === canonicalJson(graph.edges);
}

export async function syncCanonicalScenes(request: SceneSyncRequest): Promise<SceneSyncResult> {
  if (request.readCurrentSourceRevision
    && await request.readCurrentSourceRevision() !== request.graph.sourceRevision) {
    throw new Error("scene source revision changed before sync");
  }
  const owner = `scene-definition:${request.graph.projectId}`;
  const before = await readKnowledge(request.knowledgeLogPath);
  if (before.head !== request.expectedHead) {
    throw new Error(`scene sync head conflict: expected ${request.expectedHead}, got ${before.head}`);
  }
  const digest = createHash("sha256")
    .update(canonicalJson({ fingerprint: request.graph.definitionFingerprint, head: request.expectedHead }), "utf8")
    .digest("hex").slice(0, 24);
  const canonicalChanged = before.head === null || !sameDerivedSet(owner, before, request.graph);
  const transaction = canonicalChanged ? await writeKnowledgeTransaction(request.knowledgeLogPath, {
    transactionId: `tx:scene-sync/${digest}`,
    analysisSnapshotId: `scene:${request.graph.definitionFingerprint}`,
    sourceRevisions: { spec: null, code: request.graph.sourceRevision, trace: null },
    origin: "code-sync",
    operations: [{
      op: "replace-derived-set",
      owner,
      nodes: request.graph.nodes,
      edges: request.graph.edges,
    }],
    provenance: {
      proposalIds: [],
      approval: { kind: "automatic", reviewRef: null },
      generatorSchema: 1,
    },
  }, request.expectedHead) : null;
  const knowledgeHead = transaction?.transactionHash ?? before.head!;
  const projected = buildSceneProjection(request.graph, knowledgeHead);
  try {
    const projection = await writeGeneratedArtifacts({
      generatedRoot: request.generatedRoot,
      artifacts: projected.artifacts,
      knowledgeHead,
      sourceRevision: request.graph.sourceRevision,
      sourceFingerprint: request.graph.definitionFingerprint,
      generatorSchema: 1,
      projectionSchema: 1,
      readCurrentKnowledgeHead: async () => (await readKnowledge(request.knowledgeLogPath)).head,
      readCurrentSourceRevision: request.readCurrentSourceRevision,
    });
    return {
      transaction,
      knowledgeHead,
      canonicalChanged,
      manifest: projected.manifest,
      canonicalCommitted: true,
      projectionsStale: false,
      projection,
      projectionError: null,
    };
  } catch (error) {
    return {
      transaction,
      knowledgeHead,
      canonicalChanged,
      manifest: projected.manifest,
      canonicalCommitted: true,
      projectionsStale: true,
      projection: null,
      projectionError: error instanceof Error ? error.message : String(error),
    };
  }
}
