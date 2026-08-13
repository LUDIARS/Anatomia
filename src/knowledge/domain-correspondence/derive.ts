import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from "../types.js";
import type {
  BusinessDomainCorrespondence,
  DomainCorrespondenceQuery,
  DomainCorrespondenceSource,
  ProgramDomainCorrespondence,
  ProgramToBusinessCorrespondence,
  SpecClauseProgramDomainCorrespondence,
} from "./types.js";

function source(node: KnowledgeNode): DomainCorrespondenceSource {
  return {
    id: node.id,
    file: node.revision.sourcePath ?? "",
    line: node.revision.sourceRange?.startLine ?? null,
  };
}

function sortedSources(ids: Iterable<string>, nodes: Map<string, KnowledgeNode>): DomainCorrespondenceSource[] {
  return [...new Set(ids)]
    .map((id) => nodes.get(id))
    .filter((node): node is KnowledgeNode => node !== undefined)
    .map(source)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function relatedSpecClauses(codeSymbolIds: Iterable<string>, clausesByCode: Map<string, Set<string>>): string[] {
  return [...codeSymbolIds].flatMap((codeSymbolId) => [...(clausesByCode.get(codeSymbolId) ?? [])]);
}

function codeToClauses(edges: readonly KnowledgeEdge[], nodes: Map<string, KnowledgeNode>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== "code-relates-spec") continue;
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    const codeId = from?.kind === "code-symbol" ? from.id : to?.kind === "code-symbol" ? to.id : null;
    const clauseId = from?.kind === "spec-clause" ? from.id : to?.kind === "spec-clause" ? to.id : null;
    if (!codeId || !clauseId) continue;
    const clauses = result.get(codeId) ?? new Set<string>();
    clauses.add(clauseId);
    result.set(codeId, clauses);
  }
  return result;
}

function ownersByCode(edges: readonly KnowledgeEdge[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== "domain-owns-code") continue;
    const owners = result.get(edge.to) ?? new Set<string>();
    owners.add(edge.from);
    result.set(edge.to, owners);
  }
  return result;
}

function programCodes(edges: readonly KnowledgeEdge[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== "program-domain-contains-code") continue;
    const codes = result.get(edge.from) ?? new Set<string>();
    codes.add(edge.to);
    result.set(edge.from, codes);
  }
  return result;
}

function correspondence(
  businessDomainId: string,
  codeSymbolIds: string[],
  nodes: Map<string, KnowledgeNode>,
  clausesByCode: Map<string, Set<string>>,
): ProgramToBusinessCorrespondence {
  return {
    businessDomainId,
    weight: codeSymbolIds.length,
    evidence: {
      codeSymbols: sortedSources(codeSymbolIds, nodes),
      specClauses: sortedSources(relatedSpecClauses(codeSymbolIds, clausesByCode), nodes),
    },
  };
}

/**
 * Derive the two independent domain layers from canonical edges without creating
 * a transitive relation in the knowledge graph.
 */
export function deriveDomainCorrespondence(state: KnowledgeGraph): DomainCorrespondenceQuery {
  const nodes = state.nodes;
  const edges = [...state.edges.values()];
  const codesByProgram = programCodes(edges);
  const owners = ownersByCode(edges);
  const clausesByCode = codeToClauses(edges, nodes);
  const programIds = [...nodes.values()].filter((node) => node.kind === "program-domain").map((node) => node.id).sort();
  const businessIds = [...nodes.values()].filter((node) => node.kind === "domain").map((node) => node.id).sort();
  const specClauseNodes = [...nodes.values()]
    .filter((node) => node.kind === "spec-clause")
    .sort((left, right) => left.id.localeCompare(right.id));

  const programDomains: ProgramDomainCorrespondence[] = programIds.map((programDomainId) => {
    const byBusiness = new Map<string, string[]>();
    const unlinked: string[] = [];
    for (const codeSymbolId of [...(codesByProgram.get(programDomainId) ?? [])].sort()) {
      const codeOwners = owners.get(codeSymbolId);
      if (!codeOwners || codeOwners.size === 0) {
        unlinked.push(codeSymbolId);
        continue;
      }
      for (const businessDomainId of codeOwners) {
        const codes = byBusiness.get(businessDomainId) ?? [];
        codes.push(codeSymbolId);
        byBusiness.set(businessDomainId, codes);
      }
    }
    return {
      programDomainId,
      businessDomains: [...byBusiness.entries()]
        .map(([businessDomainId, codeSymbolIds]) => correspondence(businessDomainId, codeSymbolIds.sort(), nodes, clausesByCode))
        .sort((left, right) => left.businessDomainId.localeCompare(right.businessDomainId)),
      unlinkedCodeSymbols: sortedSources(unlinked, nodes),
      unlinkedCodeSymbolCount: unlinked.length,
    };
  });

  const businessDomains: BusinessDomainCorrespondence[] = businessIds.map((businessDomainId) => ({
    businessDomainId,
    programDomains: programDomains
      .map((programDomain) => {
        const relation = programDomain.businessDomains.find((item) => item.businessDomainId === businessDomainId);
        return relation && {
          programDomainId: programDomain.programDomainId,
          weight: relation.weight,
          evidence: relation.evidence,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== undefined)
      .sort((left, right) => left.programDomainId.localeCompare(right.programDomainId)),
  }));

  const programsByClause = new Map<string, Map<string, string[]>>();
  for (const [programDomainId, codeIds] of codesByProgram) {
    for (const codeId of codeIds) {
      for (const clauseId of clausesByCode.get(codeId) ?? []) {
        const byProgram = programsByClause.get(clauseId) ?? new Map<string, string[]>();
        const linkedCodes = byProgram.get(programDomainId) ?? [];
        linkedCodes.push(codeId);
        byProgram.set(programDomainId, linkedCodes);
        programsByClause.set(clauseId, byProgram);
      }
    }
  }
  const specClauses: SpecClauseProgramDomainCorrespondence[] = specClauseNodes.map((specClause) => ({
    specClauseId: specClause.id,
    programDomains: [...(programsByClause.get(specClause.id) ?? new Map<string, string[]>()).entries()]
      .map(([programDomainId, codeSymbolIds]) => ({
        programDomainId,
        weight: codeSymbolIds.length,
        evidence: {
          codeSymbols: sortedSources(codeSymbolIds, nodes),
          specClause: source(specClause),
        },
      }))
      .sort((left, right) => left.programDomainId.localeCompare(right.programDomainId)),
  }));

  return { programDomains, businessDomains, specClauses };
}
