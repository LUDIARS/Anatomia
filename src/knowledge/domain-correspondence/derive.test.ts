import { describe, expect, it } from "vitest";
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from "../types.js";
import { deriveDomainCorrespondence } from "./derive.js";

function graph(nodes: KnowledgeNode[], edges: KnowledgeEdge[]): KnowledgeGraph {
  return { head: "head", transactions: [], nodes: new Map(nodes.map((node) => [node.id, node])), edges: new Map(edges.map((edge) => [edge.id, edge])) };
}

const revision = (sourcePath: string, startLine: number) => ({ sourceRevision: "r1", contentFingerprint: sourcePath, sourcePath, sourceRange: { startLine, endLine: startLine } });

describe("deriveDomainCorrespondence", () => {
  it("derives both directions with sorted CodeSymbol and SpecClause source evidence", () => {
    const state = graph([
      { id: "business:orders", kind: "domain", revision: revision("spec/domains/orders.okf", 1) },
      { id: "business:users", kind: "domain", revision: revision("spec/domains/users.okf", 1) },
      { id: "program:application", kind: "program-domain", revision: revision("src/app", 1) },
      { id: "code:b", kind: "code-symbol", revision: revision("src/app/b.ts", 20) },
      { id: "code:a", kind: "code-symbol", revision: revision("src/app/a.ts", 10) },
      { id: "code:unlinked", kind: "code-symbol", revision: revision("src/app/unlinked.ts", 30) },
      { id: "spec:orders", kind: "spec-clause", revision: revision("spec/orders.md", 8) },
    ], [
      { id: "contains:b", kind: "program-domain-contains-code", from: "program:application", to: "code:b" },
      { id: "contains:a", kind: "program-domain-contains-code", from: "program:application", to: "code:a" },
      { id: "contains:unlinked", kind: "program-domain-contains-code", from: "program:application", to: "code:unlinked" },
      { id: "owns:b", kind: "domain-owns-code", from: "business:orders", to: "code:b" },
      { id: "owns:a", kind: "domain-owns-code", from: "business:orders", to: "code:a" },
      { id: "spec:b", kind: "code-relates-spec", from: "code:b", to: "spec:orders" },
      { id: "spec:a", kind: "code-relates-spec", from: "code:a", to: "spec:orders" },
    ]);

    const derived = deriveDomainCorrespondence(state);

    expect(derived.programDomains).toEqual([{
      programDomainId: "program:application",
      businessDomains: [{
        businessDomainId: "business:orders",
        weight: 2,
        evidence: {
          codeSymbols: [
            { id: "code:a", file: "src/app/a.ts", line: 10 },
            { id: "code:b", file: "src/app/b.ts", line: 20 },
          ],
          specClauses: [{ id: "spec:orders", file: "spec/orders.md", line: 8 }],
        },
      }],
      unlinkedCodeSymbols: [{ id: "code:unlinked", file: "src/app/unlinked.ts", line: 30 }],
      unlinkedCodeSymbolCount: 1,
    }]);
    expect(derived.businessDomains).toEqual([
      { businessDomainId: "business:orders", programDomains: [{
        programDomainId: "program:application", weight: 2, evidence: derived.programDomains[0]!.businessDomains[0]!.evidence,
      }] },
      { businessDomainId: "business:users", programDomains: [] },
    ]);
    expect(derived.specClauses).toEqual([{
      specClauseId: "spec:orders",
      programDomains: [{
        programDomainId: "program:application",
        weight: 2,
        evidence: {
          codeSymbols: [
            { id: "code:a", file: "src/app/a.ts", line: 10 },
            { id: "code:b", file: "src/app/b.ts", line: 20 },
          ],
          specClause: { id: "spec:orders", file: "spec/orders.md", line: 8 },
        },
      }],
    }]);
  });

  it("is deterministic and does not store a transitive edge", () => {
    const state = graph([
      { id: "business:a", kind: "domain", revision: revision("a", 1) },
      { id: "program:a", kind: "program-domain", revision: revision("a", 1) },
      { id: "code:a", kind: "code-symbol", revision: revision("a", 1) },
    ], [
      { id: "contains", kind: "program-domain-contains-code", from: "program:a", to: "code:a" },
      { id: "owns", kind: "domain-owns-code", from: "business:a", to: "code:a" },
    ]);
    const before = [...state.edges.keys()];
    expect(deriveDomainCorrespondence(state)).toEqual(deriveDomainCorrespondence(state));
    expect([...state.edges.keys()]).toEqual(before);
  });
});
