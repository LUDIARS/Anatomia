import { describe, expect, it } from "vitest";
import type { AnchorId } from "../../types.js";
import type { ModuleUnit } from "../../modules/types.js";
import { deriveProgramDomains } from "./derive.js";
import type { ProgramDomainConfig, ProgramSymbol } from "./types.js";

const config: ProgramDomainConfig = { layers: [{ glob: "src/ui/**", layer: "presentation" }, { glob: "src/data/**", layer: "infrastructure" }], mergeCouplingThreshold: 2 };
const modules: ModuleUnit[] = [
  { id: "src/ui/buttons", kind: "dir", label: "buttons", anchors: ["a" as AnchorId], files: ["src/ui/buttons/a.ts"] },
  { id: "src/ui/forms", kind: "dir", label: "forms", anchors: ["b" as AnchorId], files: ["src/ui/forms/b.ts"] },
  { id: "src/data/sql", kind: "dir", label: "sql", anchors: ["c" as AnchorId], files: ["src/data/sql/c.ts"] },
  { id: "src/unknown", kind: "dir", label: "unknown", anchors: ["d" as AnchorId], files: ["src/unknown/d.ts"] },
];
const symbols: ProgramSymbol[] = [
  { id: "code:a", moduleId: "src/ui/buttons", path: "src/ui/buttons/a.ts" },
  { id: "code:b", moduleId: "src/ui/forms", path: "src/ui/forms/b.ts" },
  { id: "code:c", moduleId: "src/data/sql", path: "src/data/sql/c.ts" },
  { id: "code:d", moduleId: "src/unknown", path: "src/unknown/d.ts" },
];

describe("program-domain derivation", () => {
  it("uses config before framework and heuristic, merges only strong adjacent modules, and surfaces gaps", () => {
    const graph = deriveProgramDomains({ projectId: "p", sourceRevision: "r1", modules, symbols, config, coupling: new Map([["src/ui/buttons\0src/ui/forms", 2]]) });
    expect(graph.domains.find((domain) => domain.layer === "presentation")?.moduleIds).toEqual(["src/ui/buttons", "src/ui/forms"]);
    expect(graph.domains.find((domain) => domain.layer === "infrastructure")?.codeSymbolIds).toEqual(["code:c"]);
    expect(graph.diagnostics).toEqual([{ kind: "unclassified", moduleId: "src/unknown", symbolIds: ["code:d"], reason: "no-layer-rule" }]);
  });

  it("classifies dependency artifacts to infrastructure before config rules", () => {
    const depModules: ModuleUnit[] = [{ id: ".", kind: "dir", label: ".", anchors: ["e" as AnchorId], files: ["package.json", "package-lock.json"] }];
    const depSymbols: ProgramSymbol[] = [{ id: "code:e", moduleId: ".", path: "package.json" }];
    const depConfig: ProgramDomainConfig = { layers: [{ glob: "**", layer: "presentation" }], mergeCouplingThreshold: 2 };
    const graph = deriveProgramDomains({ projectId: "p", sourceRevision: "r1", modules: depModules, symbols: depSymbols, config: depConfig });
    expect(graph.domains).toEqual([expect.objectContaining({ layer: "infrastructure", moduleIds: ["."], codeSymbolIds: ["code:e"] })]);
    expect(graph.diagnostics).toEqual([]);
  });

  it("matches configured globs against Windows source paths", () => {
    const graph = deriveProgramDomains({
      projectId: "p",
      sourceRevision: "r1",
      modules: [modules[0]!],
      symbols: [{ ...symbols[0]!, path: "src\\ui\\buttons\\a.ts" }],
      config,
    });
    expect(graph.domains).toEqual([expect.objectContaining({ layer: "presentation" })]);
  });

  it("produces byte-identical JSON for the same input", () => {
    const input = { projectId: "p", sourceRevision: "r1", modules, symbols, config, coupling: new Map([["src/ui/buttons\0src/ui/forms", 2]]) };
    expect(JSON.stringify(deriveProgramDomains(input))).toBe(JSON.stringify(deriveProgramDomains(input)));
  });

  it("scopes program-domain identities to their project", () => {
    const first = deriveProgramDomains({ projectId: "first", sourceRevision: "r1", modules: [modules[0]!], symbols: [symbols[0]!], config });
    const second = deriveProgramDomains({ projectId: "second", sourceRevision: "r1", modules: [modules[0]!], symbols: [symbols[0]!], config });
    expect(first.domains[0]?.id).not.toBe(second.domains[0]?.id);
  });
});
