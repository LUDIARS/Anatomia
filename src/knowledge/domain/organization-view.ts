import type { KnowledgeGraph } from "../types.js";

export interface DomainOrganizationView {
  knowledgeHead: string | null;
  domains: Array<{
    id: string;
    name: string;
    purpose: string;
    assignable: boolean;
    parentId: string | null;
    childIds: string[];
    ownedClauseIds: string[];
    ownedCodeSymbolIds: string[];
    implementationStatus: "implemented" | "missing";
  }>;
  typedEdges: Array<{ id: string; kind: string; from: string; to: string; evidence: Record<string, unknown> | null }>;
  unassignedCodeSymbols: Array<{
    id: string;
    anchorId: string | null;
    qualifiedName: string;
    sourcePath: string;
    sourceRange?: { startLine: number; endLine: number };
  }>;
  driftFindings: Array<{
    kind: "spec-only" | "code-only";
    entityId: string;
    disposition: "none" | "gate-a" | "gate-b";
  }>;
}

export interface AnalyzedCodeSymbol {
  id: string;
  anchorId: string;
  qualifiedName: string;
  sourcePath: string;
  sourceRange: { startLine: number; endLine: number };
}

export function buildDomainOrganizationView(
  state: KnowledgeGraph,
  analyzedCodeSymbols: AnalyzedCodeSymbol[] = [],
): DomainOrganizationView {
  const edges = [...state.edges.values()].sort((a, b) => a.id.localeCompare(b.id));
  const domains = [...state.nodes.values()]
    .filter((node) => node.kind === "domain")
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node) => {
      const code = edges.filter((edge) => edge.kind === "domain-owns-code" && edge.from === node.id).map((edge) => edge.to);
      return {
        id: node.id,
        name: typeof node.data?.name === "string" ? node.data.name : node.id,
        purpose: typeof node.data?.purpose === "string" ? node.data.purpose : "",
        assignable: node.data?.assignable !== false,
        parentId: edges.find((edge) => edge.kind === "subdomain-of" && edge.from === node.id)?.to ?? null,
        childIds: edges.filter((edge) => edge.kind === "subdomain-of" && edge.to === node.id).map((edge) => edge.from),
        ownedClauseIds: edges.filter((edge) => edge.kind === "domain-owns-spec" && edge.from === node.id).map((edge) => edge.to),
        ownedCodeSymbolIds: code,
        implementationStatus: code.length > 0 ? "implemented" as const : "missing" as const,
      };
    });
  const ownedCode = new Set(edges.filter((edge) => edge.kind === "domain-owns-code").map((edge) => edge.to));
  const loggedCodeSymbols: DomainOrganizationView["unassignedCodeSymbols"] = [...state.nodes.values()]
    .filter((node) => node.kind === "code-symbol" && !ownedCode.has(node.id))
    .map((node) => ({
      id: node.id,
      anchorId: null,
      qualifiedName: typeof node.data?.qualifiedName === "string" ? node.data.qualifiedName : node.id,
      sourcePath: node.revision.sourcePath ?? "",
      sourceRange: node.revision.sourceRange,
    }));
  const byId = new Map<string, DomainOrganizationView["unassignedCodeSymbols"][number]>(
    loggedCodeSymbols.map((symbol) => [symbol.id, symbol]),
  );
  for (const symbol of analyzedCodeSymbols) {
    if (ownedCode.has(symbol.id)) continue;
    byId.set(symbol.id, symbol);
  }
  const unassignedCodeSymbols = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const driftFindings: DomainOrganizationView["driftFindings"] = [
    ...domains
      .filter((domain) => domain.implementationStatus === "missing")
      .map((domain) => ({ kind: "spec-only" as const, entityId: domain.id, disposition: "none" as const })),
    ...unassignedCodeSymbols
      .map((symbol) => ({ kind: "code-only" as const, entityId: symbol.id, disposition: "gate-b" as const })),
  ];
  return {
    knowledgeHead: state.head,
    domains,
    typedEdges: edges.map((edge) => ({ id: edge.id, kind: edge.kind, from: edge.from, to: edge.to, evidence: edge.evidence ?? null })),
    unassignedCodeSymbols,
    driftFindings,
  };
}
