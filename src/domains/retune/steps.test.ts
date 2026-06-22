import { describe, it, expect } from "vitest";
import {
  step1Domains,
  step2Assign,
  assembleFromAssignments,
  step3Group,
  applyGroups,
  step5Split,
  step6Merge,
} from "./steps.js";
import { emptyTaxonomy, findOrCreateDomain, findOrCreateModule, addDir } from "./taxonomy-ops.js";
import type { DirStat, NodeSummary } from "./types.js";
import type { DomainSkeleton } from "./prompts.js";

/** A canned LLM that answers each step by detecting its prompt. */
const fakeLlm = async (prompt: string): Promise<string> => {
  if (prompt.includes("designing the DOMAIN taxonomy")) {
    return JSON.stringify({
      domains: [
        { name: "graph", description: "code graph", moduleHints: [{ name: "graph-core", description: "core" }] },
        { name: "web", description: "panel", moduleHints: [{ name: "web", description: "panel" }] },
      ],
    });
  }
  if (prompt.includes("Assign each source directory")) {
    return JSON.stringify({
      assignments: [
        { dir: "src/graph", domain: "graph", module: "graph-core", confidence: 0.9 },
        { dir: "src/adapters/web", domain: "web", module: "web", confidence: 0.3 },
        { dir: "src/weird", domain: "", module: "", confidence: 0.1 },
      ],
    });
  }
  if (prompt.includes("were NOT confidently assigned")) {
    return JSON.stringify({
      groups: [{ domain: "misc", module: "leftovers", description: "odds", dirs: ["src/weird", "src/cost"] }],
    });
  }
  if (prompt.includes("Split it into")) {
    return JSON.stringify({
      subdomains: [
        { name: "sub-a", description: "", modules: ["m1", "m2", "m3", "m4"] },
        { name: "sub-b", description: "", modules: ["m5", "m6", "m7"] },
      ],
    });
  }
  if (prompt.includes("These modules are very small")) {
    return JSON.stringify({
      merges: [{ domain: "dom", into: "merged", description: "m", modules: ["t1", "t2"] }],
    });
  }
  return "{}";
};

const SKELETON: DomainSkeleton[] = [
  { name: "graph", description: "code graph", moduleHints: [{ name: "graph-core", description: "core" }] },
  { name: "web", description: "panel", moduleHints: [{ name: "web", description: "panel" }] },
];

function ds(dir: string): DirStat {
  return { dir, nodeCount: 3, totalSize: 30, representatives: ["a", "b"] };
}

describe("retune steps", () => {
  it("step1 parses domains + module hints", async () => {
    const { skeleton, log } = await step1Domains(fakeLlm, { project: "p", purpose: "x", specHeadings: [], dirs: [] });
    expect(skeleton.map((d) => d.name)).toEqual(["graph", "web"]);
    expect(log.step).toBe(1);
    expect(log.llm).toBe(true);
  });

  it("step2 + assemble build a taxonomy; low-confidence + unknown leftover tracked", async () => {
    const dirs = [ds("src/graph"), ds("src/adapters/web"), ds("src/weird")];
    const { assignments } = await step2Assign(fakeLlm, { skeleton: SKELETON, dirs });
    const { taxonomy, leftovers, lowConfidence } = assembleFromAssignments("p", SKELETON, assignments, dirs);
    expect(taxonomy.domains.find((d) => d.name === "graph")!.modules[0]!.paths).toEqual(["(^|/)src/graph/[^/]+$"]);
    // src/weird had empty domain/module → leftover
    expect(leftovers.map((l) => l.dir)).toContain("src/weird");
    // src/adapters/web confidence 0.3 < 0.5 → low-confidence note
    expect(lowConfidence.join()).toMatch(/adapters\/web/);
  });

  it("step3 groups leftovers and applyGroups attaches them", async () => {
    const t = emptyTaxonomy("p");
    const { groups } = await step3Group(fakeLlm, { skeleton: SKELETON, leftovers: [ds("src/weird"), ds("src/cost")] });
    applyGroups(t, groups);
    const misc = t.domains.find((d) => d.name === "misc")!;
    expect(misc.modules[0]!.name).toBe("leftovers");
    expect(misc.modules[0]!.paths.sort()).toEqual(["(^|/)src/cost/[^/]+$", "(^|/)src/weird/[^/]+$"]);
  });

  it("step3 with no leftovers does not call the LLM", async () => {
    const { groups, log } = await step3Group(fakeLlm, { skeleton: SKELETON, leftovers: [] });
    expect(groups).toEqual([]);
    expect(log.llm).toBe(false);
  });

  it("step5 splits an over-large domain", async () => {
    const t = emptyTaxonomy("p");
    const d = findOrCreateDomain(t, "big", "b");
    for (const m of ["m1", "m2", "m3", "m4", "m5", "m6", "m7"]) addDir(findOrCreateModule(d, m, ""), `src/${m}`);
    const { log } = await step5Split(fakeLlm, t, 6);
    expect(log.step).toBe(5);
    expect(t.domains.map((x) => x.name).sort()).toEqual(["sub-a", "sub-b"]);
  });

  it("step5 is a no-op when no domain is over the cap", async () => {
    const t = emptyTaxonomy("p");
    const d = findOrCreateDomain(t, "small", "s");
    addDir(findOrCreateModule(d, "m1", ""), "src/m1");
    const { log } = await step5Split(fakeLlm, t, 6);
    expect(log.llm).toBe(false);
    expect(t.domains).toHaveLength(1);
  });

  it("step6 merges tiny modules", async () => {
    const t = emptyTaxonomy("p");
    const d = findOrCreateDomain(t, "dom", "d");
    addDir(findOrCreateModule(d, "t1", ""), "src/t1");
    addDir(findOrCreateModule(d, "t2", ""), "src/t2");
    // each owns 1 node (< MIN 3) → both are tiny → merge fires
    const nodes: NodeSummary[] = [
      { id: "1", name: "a", relPath: "src/t1/a.ts", dir: "src/t1", cyclomatic: 1, fanIn: 0, fanOut: 0, coupling: 0, size: 1 },
      { id: "2", name: "b", relPath: "src/t2/b.ts", dir: "src/t2", cyclomatic: 1, fanIn: 0, fanOut: 0, coupling: 0, size: 1 },
    ];
    const { log } = await step6Merge(fakeLlm, t, nodes, 3);
    expect(log.step).toBe(6);
    expect(d.modules.map((m) => m.name)).toEqual(["merged"]);
  });
});
