import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withDomainWorkflowLock } from "../../domains/workflow/keyed-mutex.js";
import { withFileRollback } from "../../domains/workflow/file-rollback.js";
import { replayKnowledgeLog, writeKnowledgeTransaction } from "../log.js";
import type { KnowledgeGraph, KnowledgeOperation, KnowledgeTransaction } from "../types.js";
import { contentHash, domainOkfFileName, renderDomainOkf } from "./domain-okf.js";
import { validateDomainHierarchy } from "./hierarchy.js";
import type { ApprovedDomain, DomainHierarchyEdge, DomainProposal } from "./types.js";

export interface GateARequest {
  confirmApply: boolean;
  repoRoot: string;
  service: string;
  domainRoot: string;
  knowledgeLogPath: string;
  proposals: DomainProposal[];
  existingDomains?: ApprovedDomain[];
  hierarchy: DomainHierarchyEdge[];
  sourceRevision: string;
  analysisSnapshotId: string;
  expectedHead: string | null;
  reviewRef: string | null;
  rebuildProjections?: () => Promise<void>;
}

export interface GateApplyResult {
  transaction: KnowledgeTransaction;
  canonicalCommitted: true;
  projectionsStale: boolean;
  writtenDomainFiles: string[];
}

async function optionalBytes(path: string): Promise<Buffer | null> {
  try { return await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function approved(proposal: DomainProposal): ApprovedDomain {
  return {
    id: proposal.candidateId,
    name: proposal.name,
    purpose: proposal.purpose,
    responsibilities: proposal.responsibilities,
    boundary: proposal.boundary,
    assignable: proposal.assignable,
    aliases: [],
    revision: {
      sourceRevision: proposal.sourceRevision,
      contentFingerprint: contentHash(JSON.stringify(proposal)),
    },
  };
}

/**
 * The already-approved domains this Gate A does NOT restate, projected back out of
 * the canonical log so hierarchy validation sees the whole taxonomy and not just
 * the proposals in this request.
 */
function loggedDomains(state: KnowledgeGraph, restated: ApprovedDomain[]): ApprovedDomain[] {
  return [...state.nodes.values()]
    .filter((node) => node.kind === "domain" && !restated.some((domain) => domain.id === node.id))
    .map((node) => ({
      id: node.id,
      name: typeof node.data?.name === "string" ? node.data.name : node.id,
      purpose: typeof node.data?.purpose === "string" ? node.data.purpose : "",
      responsibilities: Array.isArray(node.data?.responsibilities)
        ? node.data.responsibilities.filter((value): value is string => typeof value === "string")
        : [],
      boundary: node.data?.boundary && typeof node.data.boundary === "object"
        ? node.data.boundary as ApprovedDomain["boundary"]
        : { inScope: [], outOfScope: [] },
      assignable: node.data?.assignable !== false,
      aliases: node.aliases ?? [],
      revision: node.revision,
    }));
}

/** Domain nodes, the spec clauses they claim, ownership edges, and the hierarchy. */
function gateAOperations(request: GateARequest, domains: ApprovedDomain[]): KnowledgeOperation[] {
  const operations: KnowledgeOperation[] = [];
  for (const domain of domains) {
    operations.push({ op: "upsert-node", record: { id: domain.id, kind: "domain", aliases: domain.aliases, revision: domain.revision, data: { ...domain } } });
  }
  const clauseIds = [...new Set(request.proposals.flatMap((proposal) => proposal.sourceClauseIds))];
  for (const clauseId of clauseIds) {
    operations.push({ op: "upsert-node", record: {
      id: clauseId,
      kind: "spec-clause",
      revision: { sourceRevision: request.sourceRevision, contentFingerprint: request.sourceRevision },
    } });
  }
  for (const proposal of request.proposals) {
    for (const clauseId of proposal.sourceClauseIds) {
      operations.push({ op: "upsert-edge", record: {
        id: `domain-owns-spec:${proposal.candidateId}->${clauseId}`,
        kind: "domain-owns-spec",
        from: proposal.candidateId,
        to: clauseId,
        evidence: { proposalId: proposal.proposalId },
      } });
    }
  }
  for (const edge of request.hierarchy) {
    operations.push({ op: "upsert-edge", record: {
      id: `subdomain-of:${edge.childId}->${edge.parentId}`,
      kind: "subdomain-of",
      from: edge.childId,
      to: edge.parentId,
    } });
  }
  return operations;
}

function transactionId(proposals: DomainProposal[]): string {
  const digest = createHash("sha256")
    .update(proposals.map((proposal) => proposal.proposalId).sort().join("\n"), "utf8")
    .digest("hex").slice(0, 24);
  return `tx:gate-a/${digest}`;
}

export async function applyGateA(request: GateARequest): Promise<GateApplyResult> {
  if (!request.confirmApply) throw new Error("Gate A requires confirmApply=true");
  if (request.proposals.length === 0) throw new Error("Gate A requires at least one proposal");
  for (const proposal of request.proposals) {
    if (proposal.sourceRevision !== request.sourceRevision) throw new Error(`stale proposal ${proposal.proposalId}: source revision changed`);
    if (proposal.analysisSnapshotId !== request.analysisSnapshotId) throw new Error(`stale proposal ${proposal.proposalId}: analysis snapshot changed`);
    if (proposal.expectedHead !== request.expectedHead) throw new Error(`stale proposal ${proposal.proposalId}: expected head changed`);
  }

  const domains = request.proposals.map((proposal) => approved(proposal));
  const files = domains.map((domain) => ({
    path: join(request.domainRoot, domainOkfFileName(domain.id)),
    content: renderDomainOkf(domain, request.hierarchy, request.service),
    proposal: request.proposals.find((proposal) => proposal.candidateId === domain.id)!,
  }));
  return withDomainWorkflowLock(request.repoRoot, request.domainRoot, async () => {
    const logBefore = await optionalBytes(request.knowledgeLogPath);
    const state = replayKnowledgeLog(logBefore?.toString("utf8") ?? "");
    if (state.head !== request.expectedHead) throw new Error(`Gate A head conflict: expected ${request.expectedHead}, got ${state.head}`);
    const existingDomains = request.existingDomains ?? loggedDomains(state, domains);
    validateDomainHierarchy([...existingDomains, ...domains], request.hierarchy);
    for (const file of files) {
      const current = await optionalBytes(file.path);
      const expected = file.proposal.expectedDomainContentHash;
      if (current && (expected === null || contentHash(current) !== expected)) {
        throw new Error(`domain OKF merge conflict: ${file.path}`);
      }
    }

    const operations = gateAOperations(request, domains);

    const targets = [request.knowledgeLogPath, ...files.map((file) => file.path)];
    const transaction = await withFileRollback(targets, async () => {
      await mkdir(request.domainRoot, { recursive: true });
      for (const file of files) await writeFile(file.path, file.content, "utf8");
      return writeKnowledgeTransaction(request.knowledgeLogPath, {
        transactionId: transactionId(request.proposals),
        analysisSnapshotId: request.analysisSnapshotId,
        sourceRevisions: { spec: request.sourceRevision, code: null, trace: null },
        origin: "human-approval",
        operations,
        provenance: {
          proposalIds: request.proposals.map((proposal) => proposal.proposalId),
          approval: { kind: "human", reviewRef: request.reviewRef },
          generatorSchema: 1,
        },
      }, request.expectedHead);
    });

    let projectionsStale = false;
    if (request.rebuildProjections) {
      try { await request.rebuildProjections(); }
      catch { projectionsStale = true; }
    }
    return { transaction, canonicalCommitted: true, projectionsStale, writtenDomainFiles: files.map((file) => file.path) };
  });
}
