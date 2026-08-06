import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryCodeGraph } from "../../graph/in-memory.js";
import type { CodeGraph } from "../../graph/build.js";
import type { AnalysisContext } from "../../core.js";
import type { AnchorId, CodeNode, Edge } from "../../types.js";
import type { ScreenGraph } from "../../screens/index.js";
import { describeCodeSymbol } from "../code-symbol.js";
import { replayKnowledgeLog } from "../log.js";
import type { CanonicalSceneGraph, SceneDefinitionSeed } from "./types.js";
import { attachSceneObservations } from "./observations.js";
import { deriveCanonicalSceneGraph } from "./derive.js";
import { inventoryScreenScenes, reconcileSceneInventory, resolveSceneIdentity } from "./inventory.js";
import { computeSceneSourceRevision, sceneKnowledgePaths } from "./project-reader.js";
import { syncCanonicalScenes } from "./sync.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const anchor = (value: string) => value as AnchorId;
function codeNode(id: string, file: string, name = id): CodeNode {
  return {
    id: anchor(id),
    name,
    signatureShape: `void ${name}()`,
    kind: "function",
    sourceRange: { filePath: file, start: { line: 1, column: 0 }, end: { line: 2, column: 0 } },
  };
}

function context(
  nodes = [codeNode("entry", "/repo/ui/page.ts"), codeNode("reached", "/repo/core/work.ts"), codeNode("unreachable", "/repo/core/unused.ts")],
  edges: Edge[] = [{ from: anchor("entry"), to: anchor("reached"), kind: "calls" }],
): AnalysisContext {
  const adjacency = new Map<AnchorId, Edge[]>();
  const reverseAdjacency = new Map<AnchorId, Edge[]>();
  for (const item of edges) {
    adjacency.set(item.from, [...(adjacency.get(item.from) ?? []), item]);
    reverseAdjacency.set(item.to, [...(reverseAdjacency.get(item.to) ?? []), item]);
  }
  const graph: CodeGraph = { nodes: new Map(nodes.map((node) => [node.id, node])), adjacency, reverseAdjacency, edges };
  return { repoPath: "/repo", graph: new InMemoryCodeGraph(graph), files: [], functions: [] } as unknown as AnalysisContext;
}

const screens: ScreenGraph = {
  screens: [{
    name: "Page",
    file: "ui/page.ts",
    line: 1,
    kind: "page",
    stack: "web",
    route: "/page",
    contains: [],
    navigatesTo: [],
    reason: "route detector",
    domains: [],
  }],
  summary: { total: 1, byStack: { web: 1 }, byKind: { page: 1 }, edges: 0 },
};

function sceneDefinition(
  sceneId: string,
  path: string,
  options: { referenceKeys?: string[]; containsRefs?: string[] } = {},
): SceneDefinitionSeed {
  return {
    sceneId,
    nativeIdentity: path,
    identityBasis: "qualified-entry",
    label: sceneId,
    kind: "view",
    origin: "static-code",
    sourceRevision: "sha256:source",
    sourceAnchor: { path, startLine: 1, endLine: 1, detector: "test", reason: "test" },
    entryAnchorIds: [],
    referenceKeys: options.referenceKeys ?? [path],
    containsRefs: options.containsRefs ?? [],
    transitionRefs: [],
    aliases: [],
    tombstone: false,
  };
}

describe("scene inventory", () => {
  it("rejects project ids that could escape the knowledge-log directory", () => {
    expect(() => sceneKnowledgePaths({
      id: "../../escape",
      name: "escape",
      rootPath: "/repo",
      knowledgeWriteRoot: "/repo/spec",
      addedAt: "2026-08-04T00:00:00.000Z",
    })).toThrow(/path-safe project id/);
  });

  it("invalidates the scene revision when approved spec links change", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-scene-revision-"));
    roots.push(root);
    const writeRoot = join(root, "spec");
    await mkdir(join(writeRoot, "data"), { recursive: true });
    await writeFile(join(root, "source.ts"), "export function work() {}\n", "utf8");
    const project = {
      id: "p",
      name: "p",
      rootPath: root,
      knowledgeWriteRoot: writeRoot,
      addedAt: "2026-08-04T00:00:00.000Z",
    };
    const before = await computeSceneSourceRevision(project);
    await writeFile(join(writeRoot, "data", "spec-links.json"), '{"version":1,"links":[]}\n', "utf8");
    const after = await computeSceneSourceRevision(project);
    expect(after).not.toBe(before);
  });

  it("keeps identity independent from the display label and separates unmatched trace", () => {
    const first = resolveSceneIdentity({ projectId: "p", routeId: "/page", sourceIdentity: "ui/page.ts" });
    const renamed = resolveSceneIdentity({ projectId: "p", routeId: "/page", sourceIdentity: "ui/renamed.ts" });
    expect(first.sceneId).toBe(renamed.sceneId);
    const definition: SceneDefinitionSeed = {
      ...first,
      label: "Page",
      kind: "page",
      origin: "route",
      sourceRevision: "sha256:source",
      sourceAnchor: { path: "ui/page.ts", startLine: 1, endLine: 1, detector: "test", reason: "route" },
      entryAnchorIds: ["entry"],
      referenceKeys: ["Page", "/page"],
      containsRefs: [],
      transitionRefs: [],
      aliases: [],
      tombstone: false,
    };
    const observations = attachSceneObservations([definition], "trace:one", [
      { observedAnchorIds: ["entry"] },
      { observedAnchorIds: ["unknown"], phaseLabel: "Mystery" },
    ]);
    expect(observations[0].sceneId).toBe(definition.sceneId);
    expect(observations[1]).toMatchObject({ sceneId: null, confidence: 0 });
  });

  it("keeps same-named unrouted screens in different files distinct", async () => {
    const duplicateScreens: ScreenGraph = {
      screens: [
        { ...screens.screens[0], name: "SettingsView", file: "ui/account/settings.ts", kind: "view", route: undefined },
        { ...screens.screens[0], name: "SettingsView", file: "ui/admin/settings.ts", kind: "view", route: undefined },
      ],
      summary: { total: 2, byStack: { web: 2 }, byKind: { view: 2 }, edges: 0 },
    };
    const ctx = context([
      codeNode("account-settings", "/repo/ui/account/settings.ts", "SettingsView"),
      codeNode("admin-settings", "/repo/ui/admin/settings.ts", "SettingsView"),
    ], []);
    const definitions = await inventoryScreenScenes("p", ctx, duplicateScreens, "sha256:source");
    expect(new Set(definitions.map((definition) => definition.sceneId)).size).toBe(2);
  });

  it("links a uniquely identifiable moved scene to its tombstoned predecessor", () => {
    const previous = sceneDefinition("scene:p/old", "ui/old/settings.ts", {
      referenceKeys: ["SettingsView", "ui/old/settings.ts#SettingsView"],
    });
    const current = sceneDefinition("scene:p/new", "ui/new/settings.ts", {
      referenceKeys: ["SettingsView", "ui/new/settings.ts#SettingsView"],
    });
    const reconciled = reconcileSceneInventory([previous], [current]);
    expect(reconciled.find((definition) => definition.sceneId === current.sceneId)?.aliases)
      .toContain(previous.sceneId);
    expect(reconciled.find((definition) => definition.sceneId === previous.sceneId)?.tombstone)
      .toBe(true);
  });
});

describe("exact canonical scene graph", () => {
  it("derives domain/spec only from reached exact CodeSymbols", async () => {
    const ctx = context();
    ctx.specClauses = [{
      id: "spec:p/work#one",
      sourceFile: "/repo/spec/work.md",
      heading: "Work / one",
      text: "Reached work is implemented.",
      revisionHash: "sha256:spec-clause",
      embedding: null,
    }];
    ctx.links = [{
      from: anchor("/repo/core/work.ts"),
      to: "spec:p/work#one",
      confidence: 1,
      evidence: "explicit",
    }];
    const definitions = await inventoryScreenScenes("p", ctx, screens, "sha256:source");
    const nodes = new Map((await ctx.graph.allNodes()).map((node) => [String(node.id), node]));
    const entry = describeCodeSymbol("p", "/repo", nodes.get("entry")!, "sha256:source");
    const reached = describeCodeSymbol("p", "/repo", nodes.get("reached")!, "sha256:source");
    const unreachable = describeCodeSymbol("p", "/repo", nodes.get("unreachable")!, "sha256:source");
    const state = replayKnowledgeLog("");
    state.nodes.set("domain:p/work", { id: "domain:p/work", kind: "domain", revision: { sourceRevision: "spec", contentFingerprint: "domain" } });
    for (const symbol of [entry, reached, unreachable]) state.nodes.set(symbol.symbolId, {
      id: symbol.symbolId, kind: "code-symbol", revision: { sourceRevision: symbol.sourceRevision, contentFingerprint: symbol.contentFingerprint },
    });
    state.edges.set("owner:reached", { id: "owner:reached", kind: "domain-owns-code", from: "domain:p/work", to: reached.symbolId });
    state.edges.set("owner:unreachable", { id: "owner:unreachable", kind: "domain-owns-code", from: "domain:p/work", to: unreachable.symbolId });
    const graph = await deriveCanonicalSceneGraph({ projectId: "p", sourceRevision: "sha256:source", context: ctx, definitions, knowledgeState: state });
    expect(graph.scenes[0].reachedCodeSymbolIds).toEqual([entry.symbolId, reached.symbolId].sort());
    expect(graph.scenes[0].activeDomainIds).toEqual(["domain:p/work"]);
    expect(graph.scenes[0].relatedSpecClauseIds).toEqual(["spec:p/work#one"]);
    expect(graph.scenes[0].reachedCodeSymbolIds).not.toContain(unreachable.symbolId);
    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: "spec:p/work#one", kind: "spec-clause" }));
    expect(graph.edges).toContainEqual(expect.objectContaining({
      kind: "code-relates-spec",
      from: reached.symbolId,
      to: "spec:p/work#one",
    }));
  });

  it("rejects ambiguous composition references instead of choosing by sort order", async () => {
    const definitions = [
      sceneDefinition("scene:p/parent", "ui/parent.ts", {
        referenceKeys: ["ParentView"],
        containsRefs: ["SettingsView"],
      }),
      sceneDefinition("scene:p/account", "ui/account/settings.ts", {
        referenceKeys: ["SettingsView", "ui/account/settings.ts#SettingsView"],
      }),
      sceneDefinition("scene:p/admin", "ui/admin/settings.ts", {
        referenceKeys: ["SettingsView", "ui/admin/settings.ts#SettingsView"],
      }),
    ];
    await expect(deriveCanonicalSceneGraph({
      projectId: "p",
      sourceRevision: "sha256:source",
      context: context([], []),
      definitions,
      knowledgeState: replayKnowledgeLog(""),
    })).rejects.toThrow(/ambiguous scene reference "SettingsView"/);
  });

  it("keeps a reused component out of the single-parent subscene hierarchy", async () => {
    const childRef = "ui/shared.ts#SharedView";
    const graph = await deriveCanonicalSceneGraph({
      projectId: "p",
      sourceRevision: "sha256:source",
      context: context([], []),
      definitions: [
        sceneDefinition("scene:p/one", "ui/one.ts", { containsRefs: [childRef] }),
        sceneDefinition("scene:p/two", "ui/two.ts", { containsRefs: [childRef] }),
        sceneDefinition("scene:p/shared", childRef),
      ],
      knowledgeState: replayKnowledgeLog(""),
    });
    expect(graph.edges.filter((edge) => edge.kind === "scene-contains")).toHaveLength(2);
    expect(graph.edges.some((edge) => edge.kind === "subscene-of" && edge.from === "scene:p/shared")).toBe(false);
  });
});

describe("scene sync", () => {
  it("does not append a second transaction or rewrite identical projection bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-scene-sync-"));
    roots.push(root);
    const identity = resolveSceneIdentity({ projectId: "p", routeId: "/page", sourceIdentity: "ui/page.ts" });
    const scene = {
      id: identity.sceneId,
      nativeIdentity: identity.nativeIdentity,
      referenceKeys: ["/page"],
      label: "Page",
      kind: "page",
      origin: "route" as const,
      sourceRevision: "sha256:source",
      identityBasis: identity.identityBasis,
      sourceAnchor: { path: "ui/page.ts", startLine: 1, endLine: 1, detector: "test", reason: "route" },
      aliases: [], tombstone: false, entryCodeSymbolIds: [], reachedCodeSymbolIds: [], activeDomainIds: [],
      relatedSpecClauseIds: [], containedSceneIds: [], transitionSceneIds: [], elements: [],
    };
    const graph: CanonicalSceneGraph = {
      schemaVersion: 1, projectId: "p", sourceRevision: "sha256:source", definitionFingerprint: "sha256:def",
      scenes: [scene], nodes: [{
        id: scene.id, kind: "scene", revision: { sourceRevision: "sha256:source", contentFingerprint: "sha256:scene" },
        data: { ...scene, derivedOwner: "scene-definition:p" },
      }], edges: [],
    };
    const logPath = join(root, "p.knowledge.jsonl");
    const generatedRoot = join(root, "generated");
    const first = await syncCanonicalScenes({ graph, knowledgeLogPath: logPath, generatedRoot, expectedHead: null });
    const manifestBefore = await readFile(join(generatedRoot, "scene-manifest.json"));
    const second = await syncCanonicalScenes({ graph, knowledgeLogPath: logPath, generatedRoot, expectedHead: first.knowledgeHead });
    expect(second.canonicalChanged).toBe(false);
    expect(second.transaction).toBeNull();
    expect(await readFile(join(generatedRoot, "scene-manifest.json"))).toEqual(manifestBefore);
  });
});
