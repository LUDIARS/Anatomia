/**
 * Script receiver typing and override dispatch (Ludellus PR #1757 の静的呼び出し元なし).
 *
 * 身体判定ゲームでは、 実際に呼ばれている関数が「呼び出し元なし」と報告されていた。
 *   - factory が返すオブジェクトのメソッド (`this.detector.update()`)
 *   - getter のプロパティ参照 (`this.game.question`)
 *   - SceneManager が基底 Scene 越しに配送する override (`this.active.onBody()`)
 * 一方で、 どれにも当たらない本当の未使用関数は orphan のまま残ること、
 * 同名メソッドへ無差別に辺を張らないことも固定する。
 */

import { describe, expect, it } from "vitest";
import { parse } from "../../dag/parser.js";
import { extractFunctions, extractTypeDecls } from "../../dag/extract.js";
import { normalize } from "../../dag/normalize.js";
import { assignAnchorId } from "../../dag/hash.js";
import { buildFileNode } from "../../dag/merkle.js";
import { buildGraph, extractEdgeInfo } from "../build.js";
import { resolveOverrideDispatch } from "../override-dispatch.js";
import type { FileNode } from "../../types.js";

async function analyze(...sources: Array<{ path: string; src: string }>) {
  const files: FileNode[] = [];
  for (const { path, src } of sources) {
    const tree = await parse(src, "typescript");
    const fns = extractFunctions(tree, src, path);
    for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst!));
    files.push(buildFileNode(path, fns, extractTypeDecls(tree, path)));
    tree.delete();
  }
  const graph = buildGraph(files, extractEdgeInfo(files));
  const fns = files.flatMap((file) => file.functions);
  const label = (id: string): string => {
    const fn = fns.find((candidate) => candidate.id === id)!;
    return fn.enclosingType ? `${fn.enclosingType}.${fn.name}` : fn.name;
  };
  const calls = graph.edges.filter((edge) => edge.kind === "calls").map((edge) => `${label(edge.from)}->${label(edge.to)}`).sort();
  const dispatch = resolveOverrideDispatch(graph).map((evidence) => `${label(evidence.target)}:${evidence.via}`).sort();
  const fanIn = (name: string): number => {
    const fn = fns.find((candidate) => label(candidate.id!) === name)!;
    return (graph.reverseAdjacency.get(fn.id!) ?? []).filter((edge) => edge.kind === "calls").length;
  };
  return { graph, files, calls, dispatch, fanIn };
}

const TOUCH = {
  path: "/repo/renderer/lib/body-interaction/touch-detector.js",
  src: `
export function createBodyTouchDetector({ targets = [] } = {}) {
  let definitions = targets;
  return Object.freeze({
    setTargets(next) { definitions = next; },
    update(kind, event, nowMs) { return definitions.length ? [] : []; },
    reset() { definitions = []; },
  });
}
`,
};

const GAME = {
  path: "/repo/renderer/mr/games/uni-body-puzzle/game.js",
  src: `
export class BodyPuzzleGame {
  constructor(levels) { this.levels = levels; this.index = 0; }
  get question() { return this.levels[this.index]; }
  get nextLevel() { return this.levels[this.index + 1] ?? null; }
}
`,
};

const SCENE_BASE = {
  path: "/repo/renderer/lib/scene.js",
  src: `
export class Scene {
  init(ctx) {}
  enter() {}
  onBody(kind, ev) {}
  onResize() {}
}
`,
};

const MANAGER = {
  path: "/repo/renderer/lib/scene-manager.js",
  src: `
export class SceneManager {
  constructor() { this.active = null; }
  body(kind, ev) { if (this.active) this.active.onBody(kind, ev); }
  start(entry) { entry.instance.init({}); entry.instance.enter(); }
}
`,
};

const PUZZLE_SCENE = {
  path: "/repo/renderer/mr/games/uni-body-puzzle/scene.js",
  src: `
import { Scene } from '../../../lib/scene.js';
import { createBodyTouchDetector } from '../../../lib/body-interaction/touch-detector.js';
import { BodyPuzzleGame } from './game.js';
export class UniBodyPuzzleScene extends Scene {
  init(ctx) {
    this.game = new BodyPuzzleGame([]);
    this.detector = createBodyTouchDetector({ targets: [] });
  }
  enter() { this.detector.reset(); this.sync(); }
  sync() { this.detector.setTargets([]); }
  onBody(kind, ev) {
    const events = this.detector.update(kind, ev, 0);
    if (this.game.nextLevel) this.say(this.game.question);
    return events;
  }
  onResize() { this.sync(); }
  say(text) { return text; }
  neverUsed() { return 1; }
}
`,
};

describe("script receiver typing", () => {
  it("binds calls on a factory-built member to the factory's returned methods", async () => {
    const { calls } = await analyze(TOUCH, GAME, SCENE_BASE, MANAGER, PUZZLE_SCENE);
    expect(calls).toEqual(expect.arrayContaining([
      "UniBodyPuzzleScene.enter->createBodyTouchDetector().reset",
      "UniBodyPuzzleScene.sync->createBodyTouchDetector().setTargets",
      "UniBodyPuzzleScene.onBody->createBodyTouchDetector().update",
    ]));
  });

  it("types a local bound to a factory call the same way", async () => {
    const { calls } = await analyze(TOUCH, {
      path: "/repo/renderer/other/use.js",
      src: `
import { createBodyTouchDetector } from '../lib/body-interaction/touch-detector.js';
export function useDetector() { const d = createBodyTouchDetector(); return d.update('enter', {}, 0); }
`,
    });
    expect(calls).toContain("useDetector->createBodyTouchDetector().update");
  });

  it("resolves a getter read on a typed receiver as a call, and nothing for untyped reads", async () => {
    const { calls } = await analyze(GAME, SCENE_BASE, PUZZLE_SCENE, {
      path: "/repo/renderer/mr/games/uni-body-puzzle/layout.js",
      src: `export function layout(game) { return game.question; }`,
    });
    expect(calls).toEqual(expect.arrayContaining([
      "UniBodyPuzzleScene.onBody->BodyPuzzleGame.question",
      "UniBodyPuzzleScene.onBody->BodyPuzzleGame.nextLevel",
    ]));
    // `game` is an untyped parameter: no edge is invented for the property read.
    expect(calls.filter((call) => call.startsWith("layout->"))).toEqual([]);
  });

  it("records class heritage and constructor/factory-typed members for script classes", async () => {
    const { files } = await analyze(TOUCH, GAME, PUZZLE_SCENE);
    const decl = files.flatMap((file) => file.types ?? []).find((type) => type.name === "UniBodyPuzzleScene")!;
    expect(decl.bases).toEqual(["Scene"]);
    expect(decl.fields).toEqual([
      { name: "detector", type: null, initCall: "createBodyTouchDetector" },
      { name: "game", type: "BodyPuzzleGame" },
    ]);
  });

  it("drops a member assigned two different types instead of guessing one", async () => {
    const { files } = await analyze({
      path: "/repo/src/swap.js",
      src: `
class A { run() {} }
class B { run() {} }
export class Holder {
  first() { this.impl = new A(); }
  second() { this.impl = new B(); }
}
`,
    });
    const holder = files.flatMap((file) => file.types ?? []).find((type) => type.name === "Holder")!;
    expect(holder.fields ?? []).toEqual([]);
  });
});

describe("override dispatch evidence", () => {
  it("marks overrides of a called base method as dispatch-reachable without adding call edges", async () => {
    const { dispatch, fanIn } = await analyze(TOUCH, GAME, SCENE_BASE, MANAGER, PUZZLE_SCENE);
    expect(dispatch).toEqual(expect.arrayContaining([
      "UniBodyPuzzleScene.enter:base-call",
      "UniBodyPuzzleScene.init:base-call",
      "UniBodyPuzzleScene.onBody:base-call",
    ]));
    expect(fanIn("UniBodyPuzzleScene.onBody")).toBe(0);
  });

  it("keeps a truly unused method out of dispatch evidence", async () => {
    const { dispatch, fanIn } = await analyze(TOUCH, GAME, SCENE_BASE, MANAGER, PUZZLE_SCENE);
    expect(fanIn("UniBodyPuzzleScene.neverUsed")).toBe(0);
    expect(dispatch.some((entry) => entry.startsWith("UniBodyPuzzleScene.neverUsed"))).toBe(false);
  });

  it("does not treat an override as reachable when nothing calls that method", async () => {
    const { dispatch } = await analyze(SCENE_BASE, PUZZLE_SCENE);
    // onResize is overridden but no call site of `.onResize(` exists anywhere.
    expect(dispatch.some((entry) => entry.startsWith("UniBodyPuzzleScene.onResize"))).toBe(false);
  });

  it("marks an implementation reached through an interface-typed receiver as abstract-call", async () => {
    const { dispatch, calls } = await analyze({
      path: "/repo/src/workflow.ts",
      src: `
export interface Workflow { handle(input: string): void; }
export class ReactionWorkflow implements Workflow { handle(input: string): void { console.log(input); } }
export class Bot {
  constructor(private readonly workflow: Workflow) {}
  receive(workflow: Workflow): void { workflow.handle("x"); }
}
`,
    });
    expect(calls.filter((call) => call.endsWith("ReactionWorkflow.handle"))).toEqual([]);
    expect(dispatch).toContain("ReactionWorkflow.handle:abstract-call");
  });

  it("types a constructor parameter property, so `this.dep.m()` reaches through the interface too", async () => {
    const { dispatch } = await analyze(
      {
        path: "/repo/src/contracts/workflow.ts",
        src: `export interface Workflow { handle(input: string): void; }`,
      },
      {
        path: "/repo/src/impl/reaction.ts",
        src: `import type { Workflow } from "../contracts/workflow.js";
export class ReactionWorkflow implements Workflow { handle(input: string): void { console.log(input); } }`,
      },
      {
        path: "/repo/src/bot/bot.ts",
        src: `import type { Workflow } from "../contracts/workflow.js";
export class Bot {
  constructor(private readonly workflow: Workflow) {}
  receive(): void { this.workflow.handle("x"); }
}`,
      },
    );
    expect(dispatch).toContain("ReactionWorkflow.handle:abstract-call");
  });

  it("resolves a TypeScript parameter typed as a repo class across directories", async () => {
    const { calls } = await analyze(
      { path: "/repo/src/store/md-store.ts", src: `export class MdStore { findForProject(id: string): string { return id; } }` },
      {
        path: "/repo/src/taskflow/inject.ts",
        src: `import { MdStore } from "../store/md-store.js";
export function inject(store: MdStore): string { return store.findForProject("p"); }`,
      },
    );
    expect(calls).toContain("inject->MdStore.findForProject");
  });
});
