import { createHash } from "node:crypto";
import type { ProgramDomainGraph, ProgramSymbol } from "../../domains/program/types.js";
import { canonicalJson } from "../canonical-json.js";
import type { KnowledgeEdge, KnowledgeNode } from "../types.js";
import type { CanonicalProgramDomainGraph } from "./types.js";

function hash(value: unknown): string { return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`; }

/** Materialize program-domain output as code-authoritative knowledge records. */
export function materializeProgramDomainGraph(graph: ProgramDomainGraph, symbols: readonly ProgramSymbol[]): CanonicalProgramDomainGraph {
  const owner = `program-domain:${graph.projectId}`;
  const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const nodes: KnowledgeNode[] = [];
  const edges: KnowledgeEdge[] = [];
  for (const domain of graph.domains) {
    nodes.push({ id: domain.id, kind: "program-domain", revision: { sourceRevision: graph.sourceRevision, contentFingerprint: hash(domain) }, data: { layer: domain.layer, moduleIds: domain.moduleIds, derivedOwner: owner } });
    for (const symbolId of domain.codeSymbolIds) {
      const symbol = symbolsById.get(symbolId);
      if (!symbol) throw new Error(`program-domain ${domain.id} references unknown symbol ${symbolId}`);
      nodes.push({ id: symbol.id, kind: "code-symbol", revision: { sourceRevision: graph.sourceRevision, contentFingerprint: hash(symbol), sourcePath: symbol.path }, data: { derivedOwner: owner } });
      edges.push({ id: `program-domain-contains-code:${domain.id}->${symbol.id}`, kind: "program-domain-contains-code", from: domain.id, to: symbol.id, evidence: { derivedOwner: owner, moduleId: symbol.moduleId } });
    }
  }
  return { ...graph, nodes: nodes.sort((left, right) => left.id.localeCompare(right.id)), edges: edges.sort((left, right) => left.id.localeCompare(right.id)) };
}
