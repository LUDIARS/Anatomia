import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildProgramDomainViewPayload } from "./program-domain-view.js";

describe("program-domain-view payload", () => {
  it("surfaces layer domains, unclassified diagnostics, dependency violations, and correspondence gaps", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "program-domain-view-"));
    await mkdir(join(repoPath, ".anatomia"));
    await writeFile(join(repoPath, ".anatomia", "layers.json"), JSON.stringify({ layers: [{ glob: "infra/**", layer: "infrastructure" }, { glob: "app/**", layer: "application" }], mergeCouplingThreshold: 1 }));
    const ctx = { repoPath, functions: [{ id: "infra", sourceRange: { filePath: join(repoPath, "infra", "db.ts") } }, { id: "app", sourceRange: { filePath: join(repoPath, "app", "service.ts") } }] } as never;
    const evaluation = { modules: [{ id: "infra", kind: "dir", label: "infra", anchors: ["infra"], files: ["infra/db.ts"] }, { id: "app", kind: "dir", label: "app", anchors: ["app"], files: ["app/service.ts"] }, { id: "unclassified", kind: "dir", label: "unclassified", anchors: [], files: [] }], cohesion: [{ moduleId: "infra", cohesion: 0.4 }, { moduleId: "app", cohesion: 0.8 }], misfits: [], modularity: 0.2 } as never;
    const graph = { edges: [{ from: "infra", to: "app", memberEdgeCount: 2 }, { from: "infra", to: "infra", memberEdgeCount: 3 }], views: { class: { nodes: [{ id: "class:service", label: "Service" }], edges: [{ label: "implements" }] } } } as never;
    const first = await buildProgramDomainViewPayload(ctx, evaluation, graph, { programDomains: [], businessDomains: [], specClauses: [] });
    const infrastructure = first.layers.find((layer) => layer.layer === "infrastructure")!.domains[0]!;
    const payload = await buildProgramDomainViewPayload(ctx, evaluation, graph, { programDomains: [{ programDomainId: infrastructure.id, businessDomains: [{ businessDomainId: "business:orders", weight: 1, evidence: { codeSymbols: [{ id: "infra", file: "infra/db.ts", line: 1 }], specClauses: [] } }], unlinkedCodeSymbolCount: 1, unlinkedCodeSymbols: [{ id: "unlinked", file: "infra/free.ts", line: 2 }] }], businessDomains: [], specClauses: [] });
    expect(payload.diagnostics).toEqual([expect.objectContaining({ moduleId: "unclassified", reason: "no-layer-rule" })]);
    expect(payload.layers.map((layer) => layer.layer)).toEqual(["application", "infrastructure"]);
    expect(payload.dependencies).toEqual([expect.objectContaining({ weight: 2, layerViolation: true, modules: [{ fromModuleId: "infra", toModuleId: "app", weight: 2 }] })]);
    expect(payload.classDiagram.nodes).toEqual([expect.objectContaining({ label: "Service" })]);
    expect(payload.layers.find((layer) => layer.layer === "infrastructure")!.domains[0]).toMatchObject({ businessDomains: [expect.objectContaining({ businessDomainId: "business:orders", weight: 1 })], moduleDependencies: [{ fromModuleId: "infra", toModuleId: "infra", weight: 3 }], unlinkedCodeSymbolCount: 1 });
    await rm(repoPath, { recursive: true, force: true });
  });
});
