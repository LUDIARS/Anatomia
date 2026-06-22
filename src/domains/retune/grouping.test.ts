import { describe, it, expect } from "vitest";
import {
  moduleMembershipFilters,
  taxonomyToDomainDefs,
  assignNodeToModule,
  moduleResolver,
  unassignedNodes,
} from "./grouping.js";
import type { Taxonomy, NodeSummary } from "./types.js";

const TAX: Taxonomy = {
  version: 1,
  project: "t",
  iterations: 1,
  domains: [
    {
      name: "graph",
      description: "graph",
      modules: [
        { name: "graph-core", description: "", paths: ["^src/graph/"] },
        { name: "graph-build", description: "", paths: ["^src/graph/build/"] },
      ],
    },
    {
      name: "web",
      description: "web",
      modules: [{ name: "web", description: "", paths: ["^src/adapters/web/"], names: ["^handle"] }],
    },
  ],
};

function n(relPath: string, name: string): NodeSummary {
  return { id: relPath, name, relPath, dir: relPath.replace(/\/[^/]+$/, ""), cyclomatic: 1, fanIn: 0, fanOut: 0, coupling: 0, size: 1 };
}

describe("retune grouping", () => {
  it("module filters carry path + name patterns", () => {
    const f = moduleMembershipFilters({ name: "m", description: "", paths: ["^src/a/"], names: ["^foo"] });
    expect(f).toEqual([{ pathPattern: "^src/a/" }, { namePattern: "^foo" }]);
  });

  it("taxonomyToDomainDefs builds membership-only defs", () => {
    const defs = taxonomyToDomainDefs(TAX);
    expect(defs.map((d) => d.name)).toEqual(["graph", "web"]);
    expect(defs[0]!.presetRules).toEqual([]);
    expect(defs[0]!.membership).toEqual([{ pathPattern: "^src/graph/" }, { pathPattern: "^src/graph/build/" }]);
  });

  it("assignNodeToModule picks the longest matching path (most specific)", () => {
    expect(assignNodeToModule(TAX, "src/graph/build/x.ts", "x")).toEqual({ domain: "graph", module: "graph-build" });
    expect(assignNodeToModule(TAX, "src/graph/query.ts", "q")).toEqual({ domain: "graph", module: "graph-core" });
  });

  it("matches by name pattern when path does not match", () => {
    expect(assignNodeToModule(TAX, "src/other/z.ts", "handleRequest")).toEqual({ domain: "web", module: "web" });
  });

  it("returns null for unowned nodes; resolver mirrors that", () => {
    expect(assignNodeToModule(TAX, "src/zzz/q.ts", "q")).toBeNull();
    const r = moduleResolver(TAX);
    expect(r("src/graph/query.ts", "q")).toBe("graph-core");
    expect(r("src/zzz/q.ts", "q")).toBeNull();
  });

  it("unassignedNodes returns nodes no module owns", () => {
    const nodes = [n("src/graph/q.ts", "q"), n("src/zzz/a.ts", "a")];
    expect(unassignedNodes(TAX, nodes).map((x) => x.relPath)).toEqual(["src/zzz/a.ts"]);
  });
});
