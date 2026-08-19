/**
 * src/knowledge/entrypoint/sync.ts — Commit + project the entry-point set.
 *
 * Uses the scene / program-domain code-sync transaction pattern verbatim: the
 * derived set is REPLACED whole (entry detection is code-authoritative — a
 * removed route must disappear, not linger), the head is checked before and the
 * source revision re-read after, and a projection failure leaves the canonical
 * commit standing while reporting the artifacts as stale.
 *
 * SRP: transaction + artifact write orchestration.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeGeneratedArtifacts, type GeneratedWriteResult } from "../artifact-writer.js";
import { canonicalJson } from "../canonical-json.js";
import { replayKnowledgeLog, writeKnowledgeTransaction } from "../log.js";
import type { KnowledgeTransaction } from "../types.js";
import { buildEntryPointProjection } from "./projection.js";
import type { CanonicalEntryPointGraph, EntryPointGraphManifest } from "./types.js";

export interface EntryPointSyncRequest {
  canonical: CanonicalEntryPointGraph;
  knowledgeLogPath: string;
  generatedRoot: string;
  expectedHead: string | null;
  readCurrentSourceRevision?: () => Promise<string>;
}

export interface EntryPointSyncResult {
  transaction: KnowledgeTransaction | null;
  knowledgeHead: string;
  canonicalChanged: boolean;
  manifest: EntryPointGraphManifest;
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

function sameDerivedSet(
  owner: string,
  current: Awaited<ReturnType<typeof readKnowledge>>,
  nodes: CanonicalEntryPointGraph["nodes"],
  edges: CanonicalEntryPointGraph["edges"],
): boolean {
  const currentNodes = [...current.nodes.values()]
    .filter((node) => node.data?.["derivedOwner"] === owner)
    .sort((left, right) => left.id.localeCompare(right.id));
  const currentEdges = [...current.edges.values()]
    .filter((edge) => edge.evidence?.["derivedOwner"] === owner)
    .sort((left, right) => left.id.localeCompare(right.id));
  return canonicalJson(currentNodes) === canonicalJson(nodes)
    && canonicalJson(currentEdges) === canonicalJson(edges);
}

function nodesToReplace(
  owner: string,
  current: Awaited<ReturnType<typeof readKnowledge>>,
  canonical: CanonicalEntryPointGraph,
): CanonicalEntryPointGraph["nodes"] {
  return canonical.nodes.filter((node) => {
    const existing = current.nodes.get(node.id);
    if (existing && existing.kind !== node.kind) {
      throw new Error(`entry-point node ${node.id} conflicts with ${existing.kind}`);
    }
    // Code-symbol evidence is shared by domain, program-domain, scene, and
    // entry-point projections. Never steal its derived ownership from another
    // pipeline; the entry relation can point at the existing record instead.
    return !existing || existing.data?.["derivedOwner"] === owner || node.kind !== "code-symbol";
  });
}

export async function syncCanonicalEntryPoints(
  request: EntryPointSyncRequest,
): Promise<EntryPointSyncResult> {
  const { canonical } = request;
  if (request.readCurrentSourceRevision
    && await request.readCurrentSourceRevision() !== canonical.sourceRevision) {
    throw new Error("entry-point source revision changed before sync");
  }
  const owner = `entry-point:${canonical.projectId}`;
  const before = await readKnowledge(request.knowledgeLogPath);
  if (before.head !== request.expectedHead) {
    throw new Error(`entry-point sync head conflict: expected ${request.expectedHead}, got ${before.head}`);
  }
  const nodes = nodesToReplace(owner, before, canonical);
  const digest = createHash("sha256")
    .update(canonicalJson({ fingerprint: canonical.definitionFingerprint, head: request.expectedHead }), "utf8")
    .digest("hex").slice(0, 24);
  const canonicalChanged = before.head === null || !sameDerivedSet(owner, before, nodes, canonical.edges);
  const transaction = canonicalChanged ? await writeKnowledgeTransaction(request.knowledgeLogPath, {
    transactionId: `tx:entry-point-sync/${digest}`,
    analysisSnapshotId: `entry-point:${canonical.definitionFingerprint}`,
    sourceRevisions: { spec: null, code: canonical.sourceRevision, trace: null },
    origin: "code-sync",
    operations: [{ op: "replace-derived-set", owner, nodes, edges: canonical.edges }],
    provenance: { proposalIds: [], approval: { kind: "automatic", reviewRef: null }, generatorSchema: 1 },
  }, request.expectedHead) : null;

  const knowledgeHead = transaction?.transactionHash ?? before.head!;
  const projected = buildEntryPointProjection(canonical, knowledgeHead);
  try {
    const projection = await writeGeneratedArtifacts({
      generatedRoot: request.generatedRoot,
      artifacts: projected.artifacts,
      knowledgeHead,
      sourceRevision: canonical.sourceRevision,
      sourceFingerprint: canonical.definitionFingerprint,
      generatorSchema: 1,
      projectionSchema: 1,
      readCurrentKnowledgeHead: async () => (await readKnowledge(request.knowledgeLogPath)).head,
      ...(request.readCurrentSourceRevision ? { readCurrentSourceRevision: request.readCurrentSourceRevision } : {}),
    });
    return {
      transaction, knowledgeHead, canonicalChanged, manifest: projected.manifest,
      canonicalCommitted: true, projectionsStale: false, projection, projectionError: null,
    };
  } catch (error) {
    return {
      transaction, knowledgeHead, canonicalChanged, manifest: projected.manifest,
      canonicalCommitted: true, projectionsStale: true, projection: null,
      projectionError: error instanceof Error ? error.message : String(error),
    };
  }
}
