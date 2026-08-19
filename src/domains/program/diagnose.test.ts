import { describe, expect, it } from "vitest";
import type { FunctionNode } from "../../types.js";
import { buildProgramDomainInputs, diagnoseProgramDomains } from "./diagnose.js";
import type { ProgramDomainConfig } from "./types.js";

const repoPath = "E:/repo";
const functionNode = (path: string, id: string): FunctionNode => ({
  id: id as FunctionNode["id"],
  name: id,
  signature: `function ${id}()`,
  sourceRange: { filePath: `${repoPath}/${path}`, start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
  bodyAst: {} as FunctionNode["bodyAst"],
});

const functions = [
  functionNode("src/ui/button.ts", "ui-a"),
  functionNode("src/ui/form.ts", "ui-b"),
  functionNode("src/data/sql.ts", "data-c"),
  functionNode("src/misc/util.ts", "misc-d"),
];

describe("buildProgramDomainInputs", () => {
  it("groups functions into dir modules with repo-relative forward-slash symbol paths", () => {
    const { modules, symbols } = buildProgramDomainInputs(repoPath, functions);
    expect(modules.map((module) => module.id).sort()).toEqual(["src/data", "src/misc", "src/ui"]);
    expect(symbols.find((symbol) => symbol.id === "ui-a")).toMatchObject({ moduleId: "src/ui", path: "src/ui/button.ts" });
  });

  it("skips functions without an anchor id", () => {
    const { symbols } = buildProgramDomainInputs(repoPath, [{ ...functionNode("src/x.ts", "x"), id: null }]);
    expect(symbols).toEqual([]);
  });
});

describe("diagnoseProgramDomains", () => {
  const config: ProgramDomainConfig = {
    layers: [{ glob: "src/ui/**", layer: "presentation" }, { glob: "src/data/**", layer: "infrastructure" }],
    mergeCouplingThreshold: 1,
  };

  it("summarises layers and lists the modules no rule covers", async () => {
    const diagnosis = await diagnoseProgramDomains({ repoPath, functions, config });
    expect(diagnosis.configPresent).toBe(true);
    expect(diagnosis.layers).toEqual([
      { layer: "infrastructure", domainCount: 1, moduleCount: 1, symbolCount: 1 },
      { layer: "presentation", domainCount: 1, moduleCount: 1, symbolCount: 2 },
    ]);
    expect(diagnosis.unclassified).toEqual([
      { moduleId: "src/misc", reason: "no-layer-rule", symbolCount: 1, files: ["src/misc/util.ts"], sampleSymbolIds: ["misc-d"] },
    ]);
    expect(diagnosis.totals).toEqual({ modules: 3, symbols: 4, domains: 2, unclassifiedModules: 1, unclassifiedSymbols: 1 });
    expect(diagnosis.modules.find((module) => module.moduleId === "src/ui")).toMatchObject({ layer: "presentation", source: "config", symbolCount: 2 });
  });

  it("reports zero unclassified once every module is covered", async () => {
    const covered: ProgramDomainConfig = { layers: [...config.layers, { glob: "src/misc/**", layer: "shared" }], mergeCouplingThreshold: 1 };
    const diagnosis = await diagnoseProgramDomains({ repoPath, functions, config: covered });
    expect(diagnosis.unclassified).toEqual([]);
    expect(diagnosis.totals.unclassifiedModules).toBe(0);
    expect(diagnosis.layers.map((layer) => layer.layer)).toEqual(["infrastructure", "presentation", "shared"]);
  });

  it("flags an absent layers.json and leaves everything unclassified", async () => {
    const diagnosis = await diagnoseProgramDomains({ repoPath, functions, config: { layers: [], mergeCouplingThreshold: 1 } });
    expect(diagnosis.configPresent).toBe(false);
    expect(diagnosis.unclassified.map((item) => item.moduleId)).toEqual(["src/data", "src/misc", "src/ui"]);
  });
});
