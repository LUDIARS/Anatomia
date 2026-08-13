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
    const infraFile = join(repoPath, "infra", "db.ts");
    const appFile = join(repoPath, "app", "service.ts");
    const ctx = { repoPath, functions: [{ id: "infra", sourceRange: { filePath: infraFile, start: { line: 4 } } }, { id: "app", sourceRange: { filePath: appFile, start: { line: 8 } } }] } as never;
    const evaluation = { modules: [{ id: join(repoPath, "infra"), kind: "dir", label: "infra", anchors: ["infra"], files: [infraFile] }, { id: join(repoPath, "app"), kind: "dir", label: "app", anchors: ["app"], files: [appFile] }, { id: join(repoPath, "unclassified"), kind: "dir", label: "unclassified", anchors: [], files: [] }], cohesion: [{ moduleId: join(repoPath, "infra"), cohesion: 0.4, size: 1 }, { moduleId: join(repoPath, "app"), cohesion: 0.8, size: 1 }], misfits: [], modularity: 0.2 } as never;
    const graph = { edges: [{ from: "infra", to: "app", memberEdgeCount: 2 }, { from: "infra", to: "infra", memberEdgeCount: 3 }], views: { class: { nodes: [{ id: "class:service", label: "Service" }], edges: [{ label: "implements" }] } } } as never;
    const first = await buildProgramDomainViewPayload(ctx, evaluation, graph, { programDomains: [], businessDomains: [], specClauses: [] });
    const infrastructure = first.layers.find((layer) => layer.layer === "infrastructure")!.domains[0]!;
    const payload = await buildProgramDomainViewPayload(ctx, evaluation, graph, { programDomains: [{ programDomainId: infrastructure.id, businessDomains: [{ businessDomainId: "business:orders", weight: 1, evidence: { codeSymbols: [{ id: "infra", file: "infra/db.ts", line: 1 }], specClauses: [] } }], unlinkedCodeSymbolCount: 1, unlinkedCodeSymbols: [{ id: "unlinked", file: "infra/free.ts", line: 2 }] }], businessDomains: [], specClauses: [] });
    expect(payload.diagnostics).toEqual([expect.objectContaining({ moduleId: join(repoPath, "unclassified"), reason: "no-layer-rule" })]);
    expect(payload.layers.map((layer) => layer.layer)).toEqual(["application", "infrastructure"]);
    expect(payload.dependencies).toEqual([expect.objectContaining({ weight: 2, layerViolation: true, modules: [{ fromModuleId: join(repoPath, "infra"), toModuleId: join(repoPath, "app"), weight: 2 }] })]);
    expect(payload.classDiagram.nodes).toEqual([expect.objectContaining({ label: "Service" })]);
    expect(payload.layers.find((layer) => layer.layer === "infrastructure")!.domains[0]).toMatchObject({ businessDomains: [expect.objectContaining({ businessDomainId: "business:orders", weight: 1 })], moduleDependencies: [{ fromModuleId: join(repoPath, "infra"), toModuleId: join(repoPath, "infra"), weight: 3 }], unlinkedCodeSymbolCount: 1 });
    expect(payload.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "low-cohesion",
        targets: [{ stableId: "module:infra", file: "infra/db.ts", line: 5 }],
      }),
      expect.objectContaining({
        rule: "layer-violation",
        targets: [
          { stableId: "app", file: "app/service.ts", line: 9 },
          { stableId: "infra", file: "infra/db.ts", line: 5 },
        ],
      }),
    ]));
    expect(JSON.stringify(payload.proposals)).not.toContain(repoPath.replace(/\\/g, "/"));
    await rm(repoPath, { recursive: true, force: true });
  });
});
