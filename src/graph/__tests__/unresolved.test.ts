/**
 * Dropped-call recording (B-6): every call edge that resolution deliberately
 * drops (no phantom edges) must be recorded on CodeGraph.unresolved with the
 * reason for the drop — sorted and deduplicated, so the record is deterministic
 * and can later be joined against dynamic-trace observations
 * (spec/feature/dynamic-edge-recovery.md).
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../dag/parser.js";
import { extractFunctions, extractTypeDecls } from "../../dag/extract.js";
import { normalize } from "../../dag/normalize.js";
import { assignAnchorId } from "../../dag/hash.js";
import { buildFileNode } from "../../dag/merkle.js";
import { buildGraph, extractEdgeInfo, augmentGraph } from "../build.js";
import type { FileNode, AnchorId, UnresolvedCall } from "../../types.js";
import type { FunctionEdgeInfo } from "../build.js";

async function fileOf(
  src: string,
  path: string,
): Promise<{ file: FileNode; edgeInfo: Map<AnchorId, FunctionEdgeInfo> }> {
  const tree = await parse(src, "cpp");
  const fns = extractFunctions(tree, src, path);
  for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst));
  const types = extractTypeDecls(tree, path);
  const file = buildFileNode(path, fns, types);
  const edgeInfo = extractEdgeInfo([file]);
  tree.delete();
  return { file, edgeInfo };
}

function build(parts: { file: FileNode; edgeInfo: Map<AnchorId, FunctionEdgeInfo> }[]) {
  const files = parts.map((p) => p.file);
  const edgeInfo = new Map(parts.flatMap((p) => [...p.edgeInfo]));
  return buildGraph(files, edgeInfo);
}

const sortKey = (u: UnresolvedCall): string =>
  `${u.from}\0${u.calleeName}\0${u.receiverType ?? ""}\0${u.reason}`;

describe("unresolved call recording", () => {
  it("records a call through an abstract interface as abstract-no-impl", async () => {
    // combat owns the pure-virtual HitReceiver; alive() bodies live in player/
    // and enemy/. The dropped target.alive() edge must leave a record.
    const combat = await fileOf(
      `class HitReceiver { public: virtual bool alive() const = 0; };
       struct Hitbox { void resolve(HitReceiver& target) { if (target.alive()) {} } };`,
      "/repo/src/combat/hitbox.cpp",
    );
    const player = await fileOf(
      "class PlayerActor { public: bool alive() const { return hp_ > 0; } };",
      "/repo/src/player/player.cpp",
    );

    const g = build([combat, player]);
    const resolve = combat.file.functions.find((f) => f.name === "resolve")!.id!;

    expect(g.unresolved).toContainEqual({
      from: resolve,
      calleeName: "alive",
      receiverType: "HitReceiver",
      reason: "abstract-no-impl",
    });
    // The false cross-layer edge stays dropped.
    expect((g.adjacency.get(resolve) ?? []).filter((e) => e.kind === "calls")).toHaveLength(0);
  });

  it("records a method call on a determined non-repo type as external-type", async () => {
    // Widget is never declared in the repo; a same-named count() exists in
    // pipeline/. The edge is dropped (external method) and recorded.
    const pipeline = await fileOf("int count() { return 0; }", "/repo/src/pipeline/p.cpp");
    const scene = await fileOf(
      "void scan(Widget& w) { w.count(); }",
      "/repo/src/scene/s.cpp",
    );

    const g = build([pipeline, scene]);
    const scan = scene.file.functions.find((f) => f.name === "scan")!.id!;

    expect(g.unresolved).toContainEqual({
      from: scan,
      calleeName: "count",
      receiverType: "Widget",
      reason: "external-type",
    });
  });

  it("records a drop for an untyped receiver with no local candidate as unresolved-receiver", async () => {
    // `reg.find()` where reg cannot be typed and `find` exists only in a
    // foreign layer — the dropForeign locality drop.
    const pipeline = await fileOf("int find() { return 0; }", "/repo/src/pipeline/builder.cpp");
    const scene = await fileOf("int lookup() { return reg.find(); }", "/repo/src/scene/registry.cpp");

    const g = build([pipeline, scene]);
    const lookup = scene.file.functions.find((f) => f.name === "lookup")!.id!;

    expect(g.unresolved).toContainEqual({
      from: lookup,
      calleeName: "find",
      reason: "unresolved-receiver",
    });
  });

  it("records a call to a name undefined anywhere in the repo as no-local-candidate", async () => {
    const scene = await fileOf("void go() { launch_missiles(); }", "/repo/src/scene/go.cpp");

    const g = build([scene]);
    const go = scene.file.functions.find((f) => f.name === "go")!.id!;

    expect(g.unresolved).toContainEqual({
      from: go,
      calleeName: "launch_missiles",
      reason: "no-local-candidate",
    });
  });

  it("does NOT record a call that resolves to an edge", async () => {
    const combat = await fileOf(
      "bool alive() { return true; }\nbool sweep() { return alive(); }",
      "/repo/src/combat/hitbox.cpp",
    );

    const g = build([combat]);
    const sweep = combat.file.functions.find((f) => f.name === "sweep")!.id!;

    expect((g.adjacency.get(sweep) ?? []).some((e) => e.kind === "calls")).toBe(true);
    expect(g.unresolved).toHaveLength(0);
  });

  it("deduplicates identical drop records from distinct call sites", async () => {
    // Two untyped receivers calling the same foreign-only name collapse to a
    // single (from, callee, reason) record.
    const pipeline = await fileOf("int find() { return 0; }", "/repo/src/pipeline/builder.cpp");
    const scene = await fileOf(
      "int lookup() { a.find(); b.find(); return 0; }",
      "/repo/src/scene/registry.cpp",
    );

    const g = build([pipeline, scene]);
    expect((g.unresolved ?? []).filter((u) => u.calleeName === "find")).toHaveLength(1);
  });

  it("is deterministic: sorted output, independent of file order", async () => {
    const combat = await fileOf(
      `class HitReceiver { public: virtual bool alive() const = 0; };
       struct Hitbox { void resolve(HitReceiver& target) { if (target.alive()) {} } };`,
      "/repo/src/combat/hitbox.cpp",
    );
    const player = await fileOf(
      "class PlayerActor { public: bool alive() const { return hp_ > 0; } };",
      "/repo/src/player/player.cpp",
    );
    const scene = await fileOf(
      "void go() { launch_missiles(); }\nint lookup() { return reg.alive(); }",
      "/repo/src/scene/go.cpp",
    );

    const forward = build([combat, player, scene]);
    const reversed = build([scene, player, combat]);

    expect(forward.unresolved!.length).toBeGreaterThanOrEqual(2);
    expect(reversed.unresolved).toEqual(forward.unresolved);
    const keys = forward.unresolved!.map(sortKey);
    expect(keys).toEqual([...keys].sort());
  });

  it("augmentGraph records the diff's drops without mutating the base graph", async () => {
    // Base carries its own drop (unknown free call); the diff adds an
    // untyped-receiver drop. The overlay holds both; the base is untouched.
    const pipeline = await fileOf(
      "int find() { return 0; }\nvoid boot() { external_init(); }",
      "/repo/src/pipeline/builder.cpp",
    );
    const base = buildGraph([pipeline.file], pipeline.edgeInfo);
    const baseUnresolvedBefore = [...(base.unresolved ?? [])];
    expect(baseUnresolvedBefore).toHaveLength(1);

    const diff = await fileOf("int lookup() { return reg.find(); }", "/repo/src/scene/registry.cpp");
    const aug = augmentGraph(base, [diff.file], diff.edgeInfo);

    const lookup = diff.file.functions.find((f) => f.name === "lookup")!.id!;
    expect(aug.unresolved).toContainEqual({
      from: lookup,
      calleeName: "find",
      reason: "unresolved-receiver",
    });
    // Base's own record is carried over into the overlay…
    expect(aug.unresolved).toEqual(expect.arrayContaining(baseUnresolvedBefore));
    // …and the overlay stays sorted.
    const keys = aug.unresolved!.map(sortKey);
    expect(keys).toEqual([...keys].sort());
    // The (cached, shared) base graph is not mutated.
    expect(base.unresolved).toEqual(baseUnresolvedBefore);
  });
});
