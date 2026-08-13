import { describe, expect, it } from "vitest";
import { buildBusinessDomainViewPayload } from "./business-domain-view.js";
import type { KnowledgeGraph } from "../knowledge/types.js";
import type { DomainCorrespondenceQuery } from "../knowledge/domain-correspondence/types.js";
import type { SceneInspection } from "../knowledge/scene/types.js";

const revision = { sourceRevision: "test", contentFingerprint: "test" };

const state: KnowledgeGraph = {
  head: "head", transactions: [],
  nodes: new Map([
    ["business:implemented", { id: "business:implemented", kind: "domain", revision, data: { name: "Orders", purpose: "Place orders", boundary: { inScope: ["checkout"], outOfScope: ["shipping"] } } }],
    ["business:spec-only", { id: "business:spec-only", kind: "domain", revision, data: { name: "Policies", purpose: "Define policies" } }],
    ["business:missing", { id: "business:missing", kind: "domain", revision, data: { name: "Empty" } }],
    ["program:application", { id: "program:application", kind: "program-domain", revision }],
    ["code:place", { id: "code:place", kind: "code-symbol", revision: { ...revision, sourcePath: "src/orders.ts", sourceRange: { startLine: 12, endLine: 18 } } }],
  ]),
  edges: new Map([
    ["owns-spec", { id: "owns-spec", kind: "domain-owns-spec", from: "business:spec-only", to: "spec:policy" }],
    ["owns-code", { id: "owns-code", kind: "domain-owns-code", from: "business:implemented", to: "code:place" }],
  ]),
};

const correspondence: DomainCorrespondenceQuery = {
  programDomains: [{ programDomainId: "program:application", businessDomains: [], unlinkedCodeSymbols: [{ id: "code:unlinked", file: "src/unlinked.ts", line: 4 }], unlinkedCodeSymbolCount: 1 }],
  businessDomains: [{ businessDomainId: "business:implemented", programDomains: [{ programDomainId: "program:application", weight: 1, evidence: { codeSymbols: [{ id: "code:place", file: "src/orders.ts", line: 12 }], specClauses: [] } }] }, { businessDomainId: "business:spec-only", programDomains: [] }, { businessDomainId: "business:missing", programDomains: [] }],
  specClauses: [],
};

const inspection = { scenes: [{ id: "scene:checkout", tombstone: false, activeDomainIds: ["business:implemented"] }] } as unknown as SceneInspection;

describe("business-domain-view payload", () => {
  it("retains spec-only and missing hierarchy members, correspondence evidence, and spec refs", () => {
    const payload = buildBusinessDomainViewPayload(state, correspondence, inspection, [{ id: "spec:policy", sourceFile: "spec/policy.md", sourceLines: { start: 8, end: 10 }, heading: "Policy", text: "Policy text", domainRefs: [], embedding: null }]);
    expect(payload.domains.map((domain) => [domain.id, domain.status])).toEqual([
      ["business:implemented", "implemented"], ["business:missing", "missing"], ["business:spec-only", "spec-only"],
    ]);
    expect(payload.domains.find((domain) => domain.id === "business:spec-only")?.specRefs).toEqual([expect.objectContaining({ heading: "Policy", file: "spec/policy.md", line: 8 })]);
    expect(payload.domains.find((domain) => domain.id === "business:implemented")?.programDomains[0]).toMatchObject({ programDomainId: "program:application", weight: 1, codeSymbols: [{ file: "src/orders.ts", line: 12 }] });
    expect(payload.unlinkedProgramDomains).toEqual([expect.objectContaining({ programDomainId: "program:application", codeSymbolCount: 1 })]);
  });
});
