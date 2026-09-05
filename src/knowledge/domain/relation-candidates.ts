/**
 * src/knowledge/domain/relation-candidates.ts — Deterministic evidence for a
 * context-map relation (design §7.2 A-8, candidate half).
 *
 * A relation between two CORE domains is not observable in code directly, but
 * its evidence is: the program domains those core domains own already depend on
 * each other, and `DomainCorrespondenceQuery` records which core domain owns
 * which program domain. Aggregating the program-domain dependency edges through
 * that ownership gives the pairs a human should look at — without deciding what
 * the relation is (that is the LLM draft, and then the approval).
 *
 * SRP: aggregation only. No LLM, no writing.
 *
 * @spec コアドメイン間の関係辺（コンテキストマップ、A-8）
 */

import type { DomainCorrespondenceQuery } from "../domain-correspondence/types.js";
import type { DomainRelationCandidate } from "./relation-types.js";

/** One program-domain dependency edge (ProgramDomainViewPayload.dependencies). */
export interface ProgramDependencyEdge {
  from: string;
  to: string;
  weight: number;
}

/** Options for {@link collectDomainRelationCandidates}. */
export interface RelationCandidateOptions {
  /** Ignore pairs whose aggregated weight is below this. Default 1. */
  minWeight?: number;
}

/**
 * Aggregate program-domain dependencies into core-domain pairs.
 *
 * Ownership is many-to-many (a core domain can own several program domains, and
 * the correspondence is weighted), so an edge is attributed to EVERY owning pair
 * it connects. Self-pairs are dropped: a domain depending on itself is not a
 * context-map relation. The result is sorted (from, to) so the draft prompt and
 * any stored proposal are reproducible.
 */
export function collectDomainRelationCandidates(
  correspondence: DomainCorrespondenceQuery,
  dependencies: readonly ProgramDependencyEdge[],
  options: RelationCandidateOptions = {},
): DomainRelationCandidate[] {
  const minWeight = options.minWeight ?? 1;
  const ownersByProgram = new Map<string, string[]>();
  for (const program of correspondence.programDomains) {
    ownersByProgram.set(
      program.programDomainId,
      program.businessDomains.map((business) => business.businessDomainId).sort(),
    );
  }
  const byPair = new Map<string, DomainRelationCandidate>();
  for (const edge of dependencies) {
    for (const fromDomainId of ownersByProgram.get(edge.from) ?? []) {
      for (const toDomainId of ownersByProgram.get(edge.to) ?? []) {
        if (fromDomainId === toDomainId) continue;
        const key = `${fromDomainId}\0${toDomainId}`;
        const current = byPair.get(key)
          ?? { fromDomainId, toDomainId, weight: 0, programDomainPairs: [] };
        current.weight += edge.weight;
        current.programDomainPairs.push({ from: edge.from, to: edge.to, weight: edge.weight });
        byPair.set(key, current);
      }
    }
  }
  return [...byPair.values()]
    .filter((candidate) => candidate.weight >= minWeight)
    .map((candidate) => ({
      ...candidate,
      programDomainPairs: [...candidate.programDomainPairs].sort(
        (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
      ),
    }))
    .sort((left, right) =>
      left.fromDomainId.localeCompare(right.fromDomainId)
      || left.toDomainId.localeCompare(right.toDomainId));
}
