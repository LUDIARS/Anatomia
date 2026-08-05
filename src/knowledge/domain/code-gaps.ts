import { createHash } from "node:crypto";
import type { CodeGapProposal, CodeSymbolEvidence } from "./types.js";

export interface CodeGapInput {
  symbols: CodeSymbolEvidence[];
  calls: Array<{ from: string; to: string }>;
  linkedClauseIdsBySymbol: ReadonlyMap<string, string[]>;
  existingDomainCandidates?: Array<{ domainId: string; supporting: string[]; counterEvidence: string[] }>;
}

/** Connected components over exact symbol IDs. Results remain proposals and are never auto-approved. */
export function proposeCodeGaps(input: CodeGapInput): CodeGapProposal[] {
  const byId = new Map(input.symbols.map((symbol) => [symbol.symbolId, symbol]));
  const neighbors = new Map<string, Set<string>>();
  for (const symbol of input.symbols) neighbors.set(symbol.symbolId, new Set());
  for (const edge of input.calls) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    neighbors.get(edge.from)!.add(edge.to);
    neighbors.get(edge.to)!.add(edge.from);
  }
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const id of [...byId.keys()].sort()) {
    if (seen.has(id)) continue;
    const component: string[] = [];
    const queue = [id];
    seen.add(id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const next of neighbors.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    components.push(component.sort());
  }
  return components.map((symbolIds) => {
    const internalEdges = input.calls.filter((edge) => symbolIds.includes(edge.from) && symbolIds.includes(edge.to)).length;
    const outgoingEdges = input.calls.filter((edge) => symbolIds.includes(edge.from) !== symbolIds.includes(edge.to)).length;
    const linked = symbolIds.flatMap((id) => input.linkedClauseIdsBySymbol.get(id) ?? []);
    const digest = createHash("sha256").update(symbolIds.join("\n"), "utf8").digest("hex").slice(0, 20);
    return {
      proposalId: `proposal:code-gap/${digest}`,
      kind: linked.length === 0 ? "spec-gap" : "emergent-domain",
      symbolIds,
      sourceAnchors: symbolIds.map((id) => {
        const symbol = byId.get(id)!;
        return `${symbol.sourcePath}:${symbol.startLine}:${symbol.qualifiedName}`;
      }),
      cohesion: symbolIds.length < 2 ? 0 : internalEdges / (symbolIds.length * (symbolIds.length - 1)),
      coupling: outgoingEdges,
      existingDomainCandidates: (input.existingDomainCandidates ?? []).map((candidate) => ({
        domainId: candidate.domainId,
        supporting: [...candidate.supporting],
        counterEvidence: [...candidate.counterEvidence],
      })),
      provisionalPurpose: "Requires authored specification and human boundary definition.",
      provisionalBoundary: {
        inScope: [...symbolIds],
        outOfScope: ["Unrelated code outside this connected component"],
      },
      requiredSpecDraft: [
        "## Purpose",
        "",
        "<!-- Human authoring required: describe the user or system responsibility. -->",
        "",
        "## Boundary",
        "",
        "<!-- Define in-scope and out-of-scope behavior before Gate A. -->",
      ].join("\n"),
      unresolvedQuestions: ["What user or system responsibility makes this cluster a semantic domain?"],
      requiresGate: "gate-a",
    } satisfies CodeGapProposal;
  });
}
