/**
 * src/entrypoints/__tests__/derive.test.ts — entry traversal → product graph.
 */

import { describe, it, expect } from "vitest";
import { InMemoryCodeGraph } from "../../graph/in-memory.js";
import type { CodeGraph } from "../../graph/build.js";
import type { AnchorId, CodeNode, Edge, FunctionNode, UnresolvedCall } from "../../types.js";
import type { AnalysisContext } from "../../core.js";
import { deriveEntryPointGraph } from "../derive.js";
import { defaultEntryPointConfig } from "../config.js";
import type { EntryPointManifest } from "../types.js";
import { abs, fn, ROOT } from "./fixtures.js";

function codeNode(anchor: AnchorId, name: string, path: string): CodeNode {
  return {
    id: anchor,
    name,
    kind: "function",
    sourceRange: { start: { line: 0, column: 0 }, end: { line: 4, column: 0 }, filePath: abs(path) },
  };
}

interface ContextSpec {
  functions: FunctionNode[];
  calls: [string, string][];
  unresolved?: UnresolvedCall[];
}

function context(spec: ContextSpec): AnalysisContext {
  const byName = new Map(spec.functions.map((f) => [f.name, f.id as AnchorId]));
  const edges: Edge[] = spec.calls.map(([from, to]) => ({
    from: byName.get(from)!, to: byName.get(to)!, kind: "calls" as const,
  }));
  const adjacency = new Map<AnchorId, Edge[]>();
  const reverseAdjacency = new Map<AnchorId, Edge[]>();
  for (const edge of edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge]);
    reverseAdjacency.set(edge.to, [...(reverseAdjacency.get(edge.to) ?? []), edge]);
  }
  const raw: CodeGraph = {
    nodes: new Map(spec.functions.map((f) => [
      f.id as AnchorId,
      codeNode(f.id as AnchorId, f.name, f.sourceRange.filePath.slice(ROOT.length + 1)),
    ])),
    adjacency,
    reverseAdjacency,
    edges,
    ...(spec.unresolved ? { unresolved: spec.unresolved } : {}),
  };
  return {
    repoPath: ROOT,
    graph: new InMemoryCodeGraph(raw),
    files: [],
    functions: spec.functions,
  };
}

function manifestFor(functions: FunctionNode[], names: string[]): EntryPointManifest {
  const byName = new Map(functions.map((f) => [f.name, f]));
  return {
    entries: names.map((name) => {
      const target = byName.get(name)!;
      return {
        id: String(target.id),
        classes: ["cli-command" as const],
        detector: ["cli-command" as const],
        symbol: {
          anchor: target.id as AnchorId,
          name: target.name,
          path: target.sourceRange.filePath.slice(ROOT.length + 1),
          line: target.sourceRange.start.line,
        },
        reasons: ["fixture"],
      };
    }),
    diagnostics: [],
    config: defaultEntryPointConfig(),
  };
}

const runA = fn({ name: "runA", path: "src/a.ts" });
const shared = fn({ name: "shared", path: "src/shared.ts" });
const leaf = fn({ name: "leaf", path: "src/leaf.ts" });
const runB = fn({ name: "runB", path: "src/b.ts" });
const orphan = fn({ name: "orphan", path: "src/orphan.ts" });
const functions = [runA, shared, leaf, runB, orphan];

async function derive(overrides: Partial<Parameters<typeof deriveEntryPointGraph>[0]> = {}) {
  return deriveEntryPointGraph({
    projectId: "p",
    sourceRevision: "rev-1",
    context: context({
      functions,
      calls: [["runA", "shared"], ["shared", "leaf"], ["runB", "shared"]],
    }),
    manifest: manifestFor(functions, ["runA", "runB"]),
    ...overrides,
  });
}

describe("deriveEntryPointGraph", () => {
  it("unions the per-entry trees into reachedFrom with per-entry distances", async () => {
    const graph = await derive();
    const sharedNode = graph.nodes.find((node) => node.name === "shared")!;
    expect(sharedNode.reachedFrom).toEqual([String(runA.id), String(runB.id)].sort());
    expect(sharedNode.distance[String(runA.id)]).toBe(1);
    expect(sharedNode.via[String(runA.id)]).toBe(String(runA.id));
    const leafNode = graph.nodes.find((node) => node.name === "leaf")!;
    expect(leafNode.distance[String(runA.id)]).toBe(2);
  });

  it("lists symbols no entry reaches instead of folding them into one", async () => {
    const graph = await derive();
    expect(graph.unrooted.map((symbol) => symbol.name)).toEqual(["orphan"]);
  });

  it("marks tree edges with every entry whose tree they are on", async () => {
    const graph = await derive();
    const edge = graph.edges.find((candidate) => candidate.to === String(leaf.id))!;
    expect(edge.from).toBe(String(shared.id));
    expect(edge.onTreeOf).toEqual([String(runA.id), String(runB.id)].sort());
  });

  it("keeps dropped call sites as a frontier rather than a silent leaf", async () => {
    const graph = await deriveEntryPointGraph({
      projectId: "p",
      sourceRevision: "rev-1",
      context: context({
        functions,
        calls: [["runA", "shared"]],
        unresolved: [{
          from: shared.id as AnchorId,
          calleeName: "handle",
          receiverType: "Handler",
          reason: "abstract-no-impl",
        }],
      }),
      manifest: manifestFor(functions, ["runA"]),
    });
    const sharedNode = graph.nodes.find((node) => node.name === "shared")!;
    expect(sharedNode.frontier).toEqual([
      { calleeName: "handle", receiverType: "Handler", reason: "abstract-no-impl" },
    ]);
    expect(graph.entries[0]!.frontierCount).toBe(1);
  });

  it("diagnoses the depth cap instead of silently truncating", async () => {
    const capped = manifestFor(functions, ["runA"]);
    capped.config = { ...capped.config, traversal: { edgeKinds: ["calls"], maxDepth: 1 } };
    const graph = await deriveEntryPointGraph({
      projectId: "p",
      sourceRevision: "rev-1",
      context: context({ functions, calls: [["runA", "shared"], ["shared", "leaf"]] }),
      manifest: capped,
    });
    expect(graph.diagnostics.map((diagnostic) => diagnostic.kind)).toContain("max-depth");
    expect(graph.nodes.some((node) => node.name === "leaf")).toBe(false);
  });

  it("makes every symbol unrooted when no entry was detected", async () => {
    const empty: EntryPointManifest = {
      entries: [],
      diagnostics: [{ kind: "no-entry-detected", message: "none" }],
      config: defaultEntryPointConfig(),
    };
    const graph = await deriveEntryPointGraph({
      projectId: "p",
      sourceRevision: "rev-1",
      context: context({ functions, calls: [] }),
      manifest: empty,
    });
    expect(graph.nodes).toEqual([]);
    expect(graph.unrooted).toHaveLength(functions.length);
    expect(graph.diagnostics[0]!.kind).toBe("no-entry-detected");
  });

  it("colours nodes from the supplied domains without changing them", async () => {
    const coloring = {
      owner: new Map([[shared.id as AnchorId, "domain:p/billing"]]),
      programDomain: new Map([[shared.id as AnchorId, "program-domain:p/core"]]),
    };
    const graph = await derive({ coloring });
    const sharedNode = graph.nodes.find((node) => node.name === "shared")!;
    expect(sharedNode.owner).toBe("domain:p/billing");
    expect(sharedNode.programDomain).toBe("program-domain:p/core");
    expect(graph.entries[0]!.activatesDomains).toEqual({
      business: ["domain:p/billing"], program: ["program-domain:p/core"],
    });
    // Colouring is read-only: the source maps are untouched.
    expect(coloring.owner.size).toBe(1);
  });

  it("is deterministic: two derivations produce byte-identical JSON", async () => {
    expect(JSON.stringify(await derive())).toBe(JSON.stringify(await derive()));
  });
});
