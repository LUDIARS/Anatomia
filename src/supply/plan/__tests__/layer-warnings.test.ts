import { describe, expect, it } from "vitest";
import { buildPlanLayerWarnings, itemLayer } from "../layer-warnings.js";
import type { PlanItem } from "../types.js";
import type { ProgramDomainConfig } from "../../../domains/program/types.js";

const CONFIG: ProgramDomainConfig = {
  layers: [
    { glob: "src/ui/**", layer: "presentation" },
    { glob: "src/core/**", layer: "domain" },
  ],
  mergeCouplingThreshold: 1,
  order: ["domain", "presentation"],
};

function item(overrides: Partial<PlanItem> & Pick<PlanItem, "id">): PlanItem {
  return {
    dependsOn: [],
    uxCritical: false,
    repo: "pictor",
    domain: overrides.id,
    status: "existing",
    responsibility: "x",
    plannedPaths: [],
    ownedPathPatterns: [],
    neededTypes: [],
    layer: null,
    dataDefs: [],
    duplicates: [],
    exemplar: null,
    ...overrides,
  };
}

describe("itemLayer", () => {
  it("is null unless every planned path agrees on one layer", () => {
    expect(itemLayer(CONFIG, item({ id: "a", plannedPaths: ["src/ui/panel.ts"] }))).toBe("presentation");
    expect(itemLayer(CONFIG, item({ id: "a", plannedPaths: ["src/ui/a.ts", "src/core/b.ts"] }))).toBeNull();
    expect(itemLayer(CONFIG, item({ id: "a", plannedPaths: ["src/ui/a.ts", "docs/x.md"] }))).toBeNull();
    expect(itemLayer(CONFIG, item({ id: "a", plannedPaths: [] }))).toBeNull();
  });
});

describe("buildPlanLayerWarnings", () => {
  it("warns when a declared dependency points the wrong way", () => {
    const analysis = buildPlanLayerWarnings([
      item({ id: "core", plannedPaths: ["src/core/model.ts"], dependsOn: ["ui"] }),
      item({ id: "ui", plannedPaths: ["src/ui/panel.ts"] }),
    ], CONFIG);
    expect(analysis.warnings).toHaveLength(1);
    expect(analysis.warnings[0]).toMatchObject({
      fromItemId: "core",
      toItemId: "ui",
      fromLayer: "domain",
      toLayer: "presentation",
    });
    expect(analysis.unresolved).toEqual([]);
  });

  it("stays silent when the dependency follows the declaration", () => {
    const analysis = buildPlanLayerWarnings([
      item({ id: "ui", plannedPaths: ["src/ui/panel.ts"], dependsOn: ["core"] }),
      item({ id: "core", plannedPaths: ["src/core/model.ts"] }),
    ], CONFIG);
    expect(analysis.warnings).toEqual([]);
    expect(analysis.unresolved).toEqual([]);
  });

  it("records an undecidable layer as unresolved instead of a violation", () => {
    const analysis = buildPlanLayerWarnings([
      item({ id: "new-domain", plannedPaths: [], status: "new", dependsOn: ["core"] }),
      item({ id: "core", plannedPaths: ["src/core/model.ts"] }),
    ], CONFIG);
    expect(analysis.warnings).toEqual([]);
    expect(analysis.unresolved).toHaveLength(1);
    expect(analysis.unresolved[0]!.reason).toContain("層が決まらない");
  });

  it("produces nothing when the decomposition stated no dependency", () => {
    const analysis = buildPlanLayerWarnings([
      item({ id: "core", plannedPaths: ["src/core/model.ts"] }),
      item({ id: "ui", plannedPaths: ["src/ui/panel.ts"] }),
    ], CONFIG);
    expect(analysis.warnings).toEqual([]);
    expect(analysis.unresolved).toEqual([]);
  });

  it("reports a dependency on an item the plan does not contain", () => {
    const analysis = buildPlanLayerWarnings([
      item({ id: "ui", plannedPaths: ["src/ui/panel.ts"], dependsOn: ["ghost"] }),
    ], CONFIG);
    expect(analysis.warnings).toEqual([]);
    expect(analysis.unresolved[0]!.reason).toContain("依存先の plan item が存在しません");
  });
});
