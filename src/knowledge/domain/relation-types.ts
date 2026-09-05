/**
 * src/knowledge/domain/relation-types.ts — Context-map relations between core
 * domains (design §7.2 A-8).
 *
 * The core-domain taxonomy is described by a LIST and a GRAPH. The list exists
 * (BusinessDomainViewPayload); the graph did not — the only domain-to-domain
 * edge in knowledge was `subdomain-of`, which is containment, not a DDD context
 * map. This file names the relation kinds and the proposal/approval shapes; the
 * edge itself is `domain-relates-domain`, with the relation kind in
 * `evidence.relation` (`KnowledgeEdge.kind` is the edge-kind discriminant and
 * must not be overloaded to carry a second taxonomy).
 *
 * SRP: types only.
 *
 * @spec コアドメイン間の関係辺（コンテキストマップ、A-8）
 */

/** DDD context-map relation kinds Anatomia records. */
export const DOMAIN_RELATION_KINDS = ["depends-on", "collaborates", "shared-kernel"] as const;

export type DomainRelationKind = (typeof DOMAIN_RELATION_KINDS)[number];

/** True for a relation kind Anatomia knows. */
export function isDomainRelationKind(value: unknown): value is DomainRelationKind {
  return typeof value === "string" && (DOMAIN_RELATION_KINDS as readonly string[]).includes(value);
}

/**
 * A relation the deterministic aggregation found evidence for, before any
 * judgement about what the relation MEANS.
 *
 * `weight` is the number of distinct code-symbol dependencies underneath the
 * pair; `programDomainPairs` keeps the program-domain edges it came from, so a
 * reviewer can see the evidence rather than a bare arrow.
 */
export interface DomainRelationCandidate {
  fromDomainId: string;
  toDomainId: string;
  weight: number;
  programDomainPairs: Array<{ from: string; to: string; weight: number }>;
}

/** A relation drafted by the LLM from a candidate, awaiting human approval. */
export interface DomainRelationProposal {
  proposalId: string;
  fromDomainId: string;
  toDomainId: string;
  relation: DomainRelationKind;
  /** One line in the repository's language, for the reviewer. */
  rationale: string;
  /** The deterministic evidence the draft was made from. */
  candidate: DomainRelationCandidate;
  /** Always true: nothing here is authoritative until a human says so. */
  draft: true;
}

/** A relation a human approved; the only thing written to the knowledge log. */
export interface ApprovedDomainRelation {
  fromDomainId: string;
  toDomainId: string;
  relation: DomainRelationKind;
  rationale: string;
  /** The proposal the approval came from, kept as edge evidence. */
  proposalId: string | null;
}

/** Stable edge id for a relation, so re-approval upserts instead of duplicating. */
export function domainRelationEdgeId(relation: { fromDomainId: string; toDomainId: string }): string {
  return `domain-relates-domain:${relation.fromDomainId}->${relation.toDomainId}`;
}
