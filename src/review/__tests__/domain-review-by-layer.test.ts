import { describe, expect, it } from "vitest";
import { buildDomainReviewByLayer, UNCLASSIFIED_LAYER } from "../domain-review-by-layer.js";
import type { DomainReviewReport } from "../domain-review.js";
import type { AnalysisContext } from "../../core.js";
import type { AnchorId } from "../../types.js";
import type { ProgramDomainConfig } from "../../domains/program/types.js";

const a = (hex: string): AnchorId => hex as unknown as AnchorId;

interface Node { id: AnchorId; kind: string; name: string; filePath: string }

const NODES: Node[] = [
  { id: a("1111111111111111"), kind: "function", name: "drawPanel", filePath: "/repo/src/ui/panel.ts" },
  { id: a("2222222222222222"), kind: "function", name: "layout", filePath: "/repo/src/ui/layout.ts" },
  { id: a("3333333333333333"), kind: "function", name: "computeModel", filePath: "/repo/src/core/model.ts" },
  { id: a("4444444444444444"), kind: "function", name: "scratch", filePath: "/repo/tools/scratch.ts" },
];

/** `computeModel` calls into the presentation layer — the wrong direction. */
const CALLS: Record<string, AnchorId[]> = {
  "3333333333333333": [a("1111111111111111")],
  "1111111111111111": [a("2222222222222222")],
};

function ctx(): AnalysisContext {
  return {
    repoPath: "/repo",
    files: [],
    functions: [],
    graph: {
      async allNodes() {
        return NODES.map((node) => ({
          ...node,
          sourceRange: { filePath: node.filePath, start: { line: 0, column: 0 }, end: { line: 1, column: 0 } },
        }));
      },
      async edgesFrom(id: AnchorId, kind: string) {
        if (kind !== "calls") return [];
        return (CALLS[id as unknown as string] ?? []).map((to) => ({ from: id, to, kind }));
      },
    },
    domains: [
      { domain: "ui", description: "", implementors: [a("1111111111111111"), a("2222222222222222")], violations: [], conforms: true },
      { domain: "model", description: "", implementors: [a("3333333333333333")], violations: [], conforms: true },
    ],
  } as unknown as AnalysisContext;
}

const REVIEW: DomainReviewReport = {
  project: "/repo",
  summary: {
    domains: 2, functions: 4, assigned: 3, coverage: 0.75, unassigned: 1,
    overlap: 0, isolated: 0, specIntegrity: 0, boundaryDrift: 0, uxCritical: 0,
  },
  domains: [
    { domain: "ui", uxCritical: false, implementors: 2, conforms: true, internalEdges: 1, boundaryEdges: 1, cohesion: 0.5, isolated: [], isolatedCount: 0 },
    { domain: "model", uxCritical: false, implementors: 1, conforms: true, internalEdges: 0, boundaryEdges: 1, cohesion: 0, isolated: [], isolatedCount: 0 },
  ],
  unassigned: [], overlap: [], specIntegrity: [], boundaryDrift: [],
};

const DECLARED: ProgramDomainConfig = {
  layers: [
    { glob: "src/core/**", layer: "domain" },
    { glob: "src/ui/**", layer: "presentation" },
  ],
  mergeCouplingThreshold: 1,
  order: ["domain", "presentation"],
};

describe("buildDomainReviewByLayer", () => {
  it("aggregates coverage, unclassified code and violating dependencies per layer", async () => {
    const report = await buildDomainReviewByLayer(ctx(), REVIEW, DECLARED);
    expect(report.policySource).toBe("declared-order");
    // Declared order first, the leftover bucket last.
    expect(report.layerOrder).toEqual(["domain", "presentation", UNCLASSIFIED_LAYER]);

    const domainLayer = report.layers.find((layer) => layer.layer === "domain")!;
    expect(domainLayer.domains).toEqual(["model"]);
    expect(domainLayer.coverage).toBe(1);
    // domain -> presentation is forbidden by the declared order.
    expect(domainLayer.violatingDependencies).toBe(1);
    expect(domainLayer.violations).toEqual([{ to: "presentation", edges: 1 }]);
    expect(domainLayer.findings.some((finding) => finding.includes("層宣言に反する依存"))).toBe(true);

    const presentation = report.layers.find((layer) => layer.layer === "presentation")!;
    expect(presentation.functions).toBe(2);
    expect(presentation.violatingDependencies).toBe(0);

    const leftover = report.layers.find((layer) => layer.layer === UNCLASSIFIED_LAYER)!;
    expect(leftover.functions).toBe(1);
    expect(leftover.unassigned).toBe(1);
    expect(leftover.findings.some((finding) => finding.includes("層に分類されていない"))).toBe(true);
  });

  it("still aggregates when the repository declares no layer policy", async () => {
    const report = await buildDomainReviewByLayer(ctx(), REVIEW, { layers: [], mergeCouplingThreshold: 1 });
    expect(report.policySource).toBe("builtin");
    expect(report.layers.map((layer) => layer.layer)).toEqual([UNCLASSIFIED_LAYER]);
    expect(report.layers[0]!.functions).toBe(4);
    // Everything is in one bucket, so no edge crosses a layer and none violates.
    expect(report.layers[0]!.violatingDependencies).toBe(0);
  });

  it("is deterministic across runs", async () => {
    const first = await buildDomainReviewByLayer(ctx(), REVIEW, DECLARED);
    const second = await buildDomainReviewByLayer(ctx(), REVIEW, DECLARED);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
