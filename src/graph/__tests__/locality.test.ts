/**
 * Call-resolution locality: when a callee name is defined in several files,
 * buildGraph resolves the edge to the caller's own file/directory rather than
 * drawing an edge to EVERY same-named definition (which manufactured false
 * cross-layer "calls up" violations on generic accessors like alive()/tick()).
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../dag/parser.js";
import { extractFunctions } from "../../dag/extract.js";
import { normalize } from "../../dag/normalize.js";
import { assignAnchorId } from "../../dag/hash.js";
import { buildFileNode } from "../../dag/merkle.js";
import { buildGraph, extractEdgeInfo } from "../build.js";
import type { FileNode, AnchorId } from "../../types.js";
import type { FunctionEdgeInfo } from "../build.js";

async function fileOf(src: string, path: string): Promise<{ file: FileNode; edgeInfo: Map<AnchorId, FunctionEdgeInfo> }> {
  const tree = await parse(src, "cpp");
  const fns = extractFunctions(tree, src, path);
  for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst));
  const file = buildFileNode(path, fns);
  const edgeInfo = extractEdgeInfo([file]);
  tree.delete();
  return { file, edgeInfo };
}

describe("call resolution locality", () => {
  it("resolves a call to the SAME-FILE definition when the name is ambiguous", async () => {
    // `alive()` defined in both combat/ and enemy/. A combat caller calling
    // alive() must resolve to combat's alive, not also draw an edge to enemy's.
    const combat = await fileOf(
      "bool alive() { return true; }\nbool sweep() { return alive(); }",
      "/repo/src/combat/hitbox.cpp",
    );
    const enemy = await fileOf("bool alive() { return false; }", "/repo/src/enemy/enemy.cpp");

    const files = [combat.file, enemy.file];
    const edgeInfo = new Map([...combat.edgeInfo, ...enemy.edgeInfo]);
    const g = buildGraph(files, edgeInfo);

    const sweep = combat.file.functions.find((f) => f.name === "sweep")!.id!;
    const combatAlive = combat.file.functions.find((f) => f.name === "alive")!.id!;
    const enemyAlive = enemy.file.functions.find((f) => f.name === "alive")!.id!;

    const outs = (g.adjacency.get(sweep) ?? []).filter((e) => e.kind === "calls").map((e) => e.to);
    expect(outs).toContain(combatAlive);
    expect(outs).not.toContain(enemyAlive);
  });

  it("keeps the cross-module edge when the name exists ONLY in another file", async () => {
    // make_ortho exists only in render/. A skill caller has no local candidate,
    // so the edge falls back to render's — real cross-layer calls still surface.
    const render = await fileOf("void make_ortho() { return; }", "/repo/src/render/r.cpp");
    const skill = await fileOf("void fire() { make_ortho(); }", "/repo/src/skill/s.cpp");

    const files = [render.file, skill.file];
    const edgeInfo = new Map([...render.edgeInfo, ...skill.edgeInfo]);
    const g = buildGraph(files, edgeInfo);

    const fire = skill.file.functions[0]!.id!;
    const makeOrtho = render.file.functions[0]!.id!;
    const outs = (g.adjacency.get(fire) ?? []).filter((e) => e.kind === "calls").map((e) => e.to);
    expect(outs).toContain(makeOrtho);
  });

  it("prefers the same DIRECTORY when no same-file match (.h/.cpp split)", async () => {
    // alive() declared/defined in a combat header; the combat .cpp caller should
    // resolve to it (same dir) rather than to an enemy-layer alive().
    const combatHeader = await fileOf("bool alive() { return true; }", "/repo/src/combat/actor.h");
    const combatImpl = await fileOf("bool sweep() { return alive(); }", "/repo/src/combat/hitbox.cpp");
    const enemy = await fileOf("bool alive() { return false; }", "/repo/src/enemy/e.cpp");

    const files = [combatHeader.file, combatImpl.file, enemy.file];
    const edgeInfo = new Map([...combatHeader.edgeInfo, ...combatImpl.edgeInfo, ...enemy.edgeInfo]);
    const g = buildGraph(files, edgeInfo);

    const sweep = combatImpl.file.functions[0]!.id!;
    const headerAlive = combatHeader.file.functions[0]!.id!;
    const enemyAlive = enemy.file.functions[0]!.id!;
    const outs = (g.adjacency.get(sweep) ?? []).filter((e) => e.kind === "calls").map((e) => e.to);
    expect(outs).toContain(headerAlive);
    expect(outs).not.toContain(enemyAlive);
  });
});
