import type { SpecClause } from "../types.js";
import type { DomainCorrespondenceQuery } from "../knowledge/domain-correspondence/types.js";
import type { SceneInspection } from "../knowledge/scene/types.js";
import type { KnowledgeGraph } from "../knowledge/types.js";
import type { BusinessDomainViewPayload } from "./types.js";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boundary(value: unknown): { inScope: string[]; outOfScope: string[] } {
  if (!value || typeof value !== "object") return { inScope: [], outOfScope: [] };
  const candidate = value as Record<string, unknown>;
  const strings = (item: unknown): string[] => Array.isArray(item)
    ? item.filter((entry): entry is string => typeof entry === "string") : [];
  return { inScope: strings(candidate["inScope"]), outOfScope: strings(candidate["outOfScope"]) };
}

/**
 * Project the approved business hierarchy without deriving or mutating anything
 * at request time. Clauses from the authored parse fill the detail omitted by
 * older Gate A log records.
 */
export function buildBusinessDomainViewPayload(
  state: KnowledgeGraph,
  correspondence: DomainCorrespondenceQuery,
  inspection: SceneInspection,
  clauses: readonly SpecClause[] = [],
): BusinessDomainViewPayload {
  const nodes = state.nodes;
  const edges = [...state.edges.values()];
  const clausesById = new Map(clauses.map((clause) => [clause.id, clause]));
  const scenesByDomain = new Map<string, string[]>();
  for (const scene of inspection.scenes) {
    if (scene.tombstone) continue;
    for (const domainId of scene.activeDomainIds) {
      scenesByDomain.set(domainId, [...(scenesByDomain.get(domainId) ?? []), scene.id]);
    }
  }
  const correspondenceByBusiness = new Map(correspondence.businessDomains.map((item) => [item.businessDomainId, item]));
  const domains = [...nodes.values()]
    .filter((node) => node.kind === "domain")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((domain) => {
      const ownedClauses = edges.filter((edge) => edge.kind === "domain-owns-spec" && edge.from === domain.id).map((edge) => edge.to).sort();
      const ownedCode = edges.filter((edge) => edge.kind === "domain-owns-code" && edge.from === domain.id);
      const specRefs = ownedClauses.map((id) => {
        const node = nodes.get(id);
        const parsed = clausesById.get(id);
        return {
          id,
          heading: text(node?.data?.["heading"]) || parsed?.heading || id,
          excerpt: text(node?.data?.["excerpt"]) || parsed?.text || "",
          file: node?.revision.sourcePath ?? parsed?.sourceFile ?? "",
          line: node?.revision.sourceRange?.startLine ?? parsed?.sourceLines?.start ?? null,
        };
      });
      const relation = correspondenceByBusiness.get(domain.id);
      return {
        id: domain.id,
        name: text(domain.data?.["name"]) || domain.id,
        purpose: text(domain.data?.["purpose"]),
        boundary: boundary(domain.data?.["boundary"]),
        status: ownedCode.length > 0 ? "implemented" as const : ownedClauses.length > 0 ? "spec-only" as const : "missing" as const,
        parentId: edges.find((edge) => edge.kind === "subdomain-of" && edge.from === domain.id)?.to ?? null,
        childIds: edges.filter((edge) => edge.kind === "subdomain-of" && edge.to === domain.id).map((edge) => edge.from).sort(),
        specRefs,
        programDomains: (relation?.programDomains ?? []).map((program) => ({
          programDomainId: program.programDomainId,
          weight: program.weight,
          codeSymbols: program.evidence.codeSymbols,
        })),
        relatedSceneIds: [...(scenesByDomain.get(domain.id) ?? [])].sort(),
      };
    });
  return {
    domains,
    unlinkedProgramDomains: correspondence.programDomains.map((program) => ({
      programDomainId: program.programDomainId,
      codeSymbolCount: program.unlinkedCodeSymbolCount,
      codeSymbols: program.unlinkedCodeSymbols,
    })),
  };
}
