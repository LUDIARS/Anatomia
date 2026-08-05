import { createHash } from "node:crypto";
import type { SpecClause } from "../../types.js";
import { domainEntityId } from "../identity.js";
import type { DomainProposal } from "./types.js";

export interface SpecProposalInput {
  projectId: string;
  clauses: SpecClause[];
  sourceRevision: string;
  analysisSnapshotId: string;
  expectedHead: string | null;
}

function readableName(value: string): string {
  // Headings are authored prose, so a bare "%" (e.g. "100% coverage") is normal
  // and must not make decodeURIComponent throw away every other proposal.
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { decoded = value; }
  return decoded.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function groupKey(clause: SpecClause): string {
  const domainRef = clause.domainRefs?.[0];
  if (domainRef) return domainRef.split("/").at(-1) ?? domainRef;
  return clause.heading.split(" / ")[0]?.trim() || "unresolved-domain";
}

function firstSentence(text: string): string {
  return text
    .replace(/`[^`]+`/g, "")
    .replace(/\b(?:[A-Za-z0-9._-]+[/\\])+[A-Za-z0-9._-]+\b/g, "")
    .replace(/\s+/g, " ")
    .split(/(?<=[。.!?])\s+/)[0]
    .trim();
}

function proposalId(projectId: string, key: string, clauseIds: string[]): string {
  const digest = createHash("sha256")
    .update(`${projectId}\n${key}\n${[...clauseIds].sort().join("\n")}`, "utf8")
    .digest("hex")
    .slice(0, 20);
  return `proposal:domain:${projectId}/${digest}`;
}

/** Deterministic first pass. Its only semantic input is parsed authored SpecClause data. */
export function proposeDomainsFromSpec(input: SpecProposalInput): DomainProposal[] {
  const groups = new Map<string, SpecClause[]>();
  for (const clause of input.clauses) {
    const key = groupKey(clause);
    groups.set(key, [...(groups.get(key) ?? []), clause]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, clauses]) => {
      const ordered = [...clauses].sort((a, b) => a.id.localeCompare(b.id));
      const sourceClauseIds = ordered.map((clause) => clause.id);
      const name = readableName(key);
      const purpose = firstSentence(ordered.find((clause) => clause.text.trim())?.text ?? name);
      return {
        proposalId: proposalId(input.projectId, key, sourceClauseIds),
        candidateId: domainEntityId(input.projectId, key),
        name,
        purpose,
        responsibilities: ordered.map((clause) => firstSentence(clause.text)).filter(Boolean),
        boundary: { inScope: sourceClauseIds, outOfScope: [] },
        assignable: true,
        sourceClauseIds,
        sourceRevision: input.sourceRevision,
        analysisSnapshotId: input.analysisSnapshotId,
        expectedHead: input.expectedHead,
        expectedDomainContentHash: null,
        parentCandidateId: null,
        assumptions: key === "unresolved-domain" ? ["domain name requires human review"] : [],
        unresolvedQuestions: [],
        evidence: {
          deterministic: sourceClauseIds.map((clauseId) => ({ clauseId, reason: "authored specification group" })),
          llm: [],
          human: [],
        },
      };
    });
}

export function applyProposalEnrichment(
  proposal: DomainProposal,
  enrichment: Partial<Pick<DomainProposal, "purpose" | "responsibilities" | "boundary" | "parentCandidateId">>,
  evidence: DomainProposal["evidence"]["llm"][number],
): DomainProposal {
  return { ...proposal, ...enrichment, evidence: { ...proposal.evidence, llm: [...proposal.evidence.llm, evidence] } };
}
