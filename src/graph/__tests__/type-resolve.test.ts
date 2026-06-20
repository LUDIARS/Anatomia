/**
 * Type-aware call resolution: when a call's receiver has a known static type,
 * the edge is resolved within that type's class hierarchy rather than fanning
 * out to every same-named definition (which manufactured false "calls up the
 * layer spine" violations on virtual accessors like alive()/position()).
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../dag/parser.js";
import { extractFunctions, extractTypeDecls } from "../../dag/extract.js";
import { normalize } from "../../dag/normalize.js";
import { assignAnchorId } from "../../dag/hash.js";
import { buildFileNode } from "../../dag/merkle.js";
import { buildGraph, extractEdgeInfo } from "../build.js";
import { TypeRegistry } from "../type-resolve.js";
import type { FileNode, AnchorId } from "../../types.js";
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

function callsFrom(g: ReturnType<typeof buildGraph>, from: AnchorId): AnchorId[] {
  return (g.adjacency.get(from) ?? []).filter((e) => e.kind === "calls").map((e) => e.to);
}

describe("type-aware call resolution", () => {
  it("drops a call through an abstract interface instead of fanning out to overrides", async () => {
    // combat owns the HitReceiver interface (pure-virtual alive()). The concrete
    // alive() bodies live in player/ and enemy/. A combat function calling
    // target.alive() on a HitReceiver& must NOT draw edges into player/enemy.
    const combat = await fileOf(
      `class HitReceiver { public: virtual bool alive() const = 0; };
       struct Hitbox { void resolve(HitReceiver& target) { if (target.alive()) {} } };`,
      "/repo/src/combat/hitbox.cpp",
    );
    const player = await fileOf(
      "class PlayerActor { public: bool alive() const { return hp_ > 0; } };",
      "/repo/src/player/player.cpp",
    );
    const enemy = await fileOf(
      "class EnemyActor { public: bool alive() const { return hp_ > 0; } };",
      "/repo/src/enemy/enemy.cpp",
    );

    const files = [combat.file, player.file, enemy.file];
    const edgeInfo = new Map([...combat.edgeInfo, ...player.edgeInfo, ...enemy.edgeInfo]);
    const g = buildGraph(files, edgeInfo);

    const resolve = combat.file.functions.find((f) => f.name === "resolve")!.id!;
    const playerAlive = player.file.functions[0]!.id!;
    const enemyAlive = enemy.file.functions[0]!.id!;

    // Known receiver type (HitReceiver) with no body for alive() in its hierarchy
    // → no calls edge at all (the false cross-layer edges are gone).
    expect(callsFrom(g, resolve)).not.toContain(playerAlive);
    expect(callsFrom(g, resolve)).not.toContain(enemyAlive);
  });

  it("resolves a concrete-typed receiver to that class's method only", async () => {
    // A direct call on a concrete PlayerActor resolves to PlayerActor::alive,
    // never to EnemyActor::alive — even though both names collide.
    const caller = await fileOf(
      `class PlayerActor { public: bool alive() const { return true; } };
       void tick(PlayerActor& p) { p.alive(); }`,
      "/repo/src/player/tick.cpp",
    );
    const enemy = await fileOf(
      "class EnemyActor { public: bool alive() const { return false; } };",
      "/repo/src/enemy/enemy.cpp",
    );

    const files = [caller.file, enemy.file];
    const edgeInfo = new Map([...caller.edgeInfo, ...enemy.edgeInfo]);
    const g = buildGraph(files, edgeInfo);

    const tick = caller.file.functions.find((f) => f.name === "tick")!.id!;
    const playerAlive = caller.file.functions.find((f) => f.name === "alive")!.id!;
    const enemyAlive = enemy.file.functions[0]!.id!;

    expect(callsFrom(g, tick)).toContain(playerAlive);
    expect(callsFrom(g, tick)).not.toContain(enemyAlive);
  });

  it("follows the base-class chain to find an inherited method", async () => {
    // PlayerActor : Actor; alive() is defined on the base Actor. A call on a
    // PlayerActor receiver must resolve up to Actor::alive.
    const base = await fileOf(
      "class Actor { public: bool alive() const { return hp_ > 0; } };",
      "/repo/src/core/actor.cpp",
    );
    const derived = await fileOf(
      `class PlayerActor : public Actor { public: void hurt() {} };
       void run(PlayerActor& p) { p.alive(); }`,
      "/repo/src/player/player.cpp",
    );

    const files = [base.file, derived.file];
    const edgeInfo = new Map([...base.edgeInfo, ...derived.edgeInfo]);
    const g = buildGraph(files, edgeInfo);

    const run = derived.file.functions.find((f) => f.name === "run")!.id!;
    const actorAlive = base.file.functions[0]!.id!;
    expect(callsFrom(g, run)).toContain(actorAlive);
  });

  it("types `this` to the enclosing class for member self-calls", async () => {
    // this->refresh() resolves to the same class's refresh, not a same-named one
    // in another layer.
    const here = await fileOf(
      `struct Widget { void draw() { this->refresh(); } void refresh() {} };`,
      "/repo/src/ui/widget.cpp",
    );
    const other = await fileOf(
      "struct Cache { void refresh() {} };",
      "/repo/src/data/cache.cpp",
    );

    const files = [here.file, other.file];
    const edgeInfo = new Map([...here.edgeInfo, ...other.edgeInfo]);
    const g = buildGraph(files, edgeInfo);

    const draw = here.file.functions.find((f) => f.name === "draw")!.id!;
    const widgetRefresh = here.file.functions.find((f) => f.name === "refresh")!.id!;
    const cacheRefresh = other.file.functions[0]!.id!;
    expect(callsFrom(g, draw)).toContain(widgetRefresh);
    expect(callsFrom(g, draw)).not.toContain(cacheRefresh);
  });

  it("types a range-for loop variable from a container parameter's element type", async () => {
    // The KS pattern: combat owns IDamageReceiver; a hitbox iterates a
    // vector<IDamageReceiver*> and calls r->alive(). The loop var r is bound by
    // `auto*`, so its type comes from the container param's element type. The
    // method has no body on the interface → edge dropped, no false up-spine call.
    const combat = await fileOf(
      `class IDamageReceiver { public: virtual bool alive() const = 0; };
       struct AttackHitbox {
         int sweep(const std::vector<IDamageReceiver*>& receivers) {
           int n = 0;
           for (auto* r : receivers) { if (r->alive()) n++; }
           return n;
         }
       };`,
      "/repo/src/combat/attack_hitbox.cpp",
    );
    const enemy = await fileOf(
      "class EnemyActor { public: bool alive() const { return true; } };",
      "/repo/src/enemy/enemy.cpp",
    );

    const files = [combat.file, enemy.file];
    const edgeInfo = new Map([...combat.edgeInfo, ...enemy.edgeInfo]);
    const g = buildGraph(files, edgeInfo);

    const sweep = combat.file.functions.find((f) => f.name === "sweep")!.id!;
    const enemyAlive = enemy.file.functions[0]!.id!;
    expect(callsFrom(g, sweep)).not.toContain(enemyAlive);
  });

  it("types an explicitly-typed range-for loop variable", async () => {
    const a = await fileOf(
      `class Widget { public: void paint() {} };
       void render(const std::vector<Widget*>& ws) { for (Widget* w : ws) { w->paint(); } }`,
      "/repo/src/ui/render.cpp",
    );
    const other = await fileOf(
      "class Sprite { public: void paint() {} };",
      "/repo/src/gfx/sprite.cpp",
    );
    const files = [a.file, other.file];
    const edgeInfo = new Map([...a.edgeInfo, ...other.edgeInfo]);
    const g = buildGraph(files, edgeInfo);
    const render = a.file.functions.find((f) => f.name === "render")!.id!;
    const widgetPaint = a.file.functions.find((f) => f.name === "paint")!.id!;
    const spritePaint = other.file.functions[0]!.id!;
    expect(callsFrom(g, render)).toContain(widgetPaint);
    expect(callsFrom(g, render)).not.toContain(spritePaint);
  });

  it("types a bare member-field receiver via the enclosing class", async () => {
    // `hit_.count()` where `hit_` is a std::unordered_set member: the field is
    // typed to an external container, so the external method is NOT wired to a
    // same-named repo function (the false `count` edge is dropped). Works for an
    // OUT-OF-LINE method definition, whose enclosing class is the `Foo::` scope.
    const combat = await fileOf(
      `struct AttackHitbox {
         std::unordered_set<int> hit_;
         int sweep();
       };
       int AttackHitbox::sweep() { return hit_.count(0); }`,
      "/repo/src/combat/hitbox.cpp",
    );
    const enemy = await fileOf(
      "struct Roster { public: int count() { return 3; } };",
      "/repo/src/enemy/roster.cpp",
    );
    const files = [combat.file, enemy.file];
    const edgeInfo = new Map([...combat.edgeInfo, ...enemy.edgeInfo]);
    const g = buildGraph(files, edgeInfo);
    const sweep = combat.file.functions.find((f) => f.name.endsWith("sweep"))!.id!;
    const rosterCount = enemy.file.functions[0]!.id!;
    expect(callsFrom(g, sweep)).not.toContain(rosterCount);
  });

  it("drops a call on an external-typed receiver instead of locality fan-out", async () => {
    // `ext` is typed `SomeExternal` (not a repo class) → the call is external →
    // it must NOT be wired to a same-named repo function by locality.
    const a = await fileOf(
      `void use(SomeExternal& ext) { ext.compute(); }
       void compute() {}`,
      "/repo/src/mod/a.cpp",
    );
    const g = buildGraph([a.file], a.edgeInfo);
    const use = a.file.functions.find((f) => f.name === "use")!.id!;
    const compute = a.file.functions.find((f) => f.name === "compute")!.id!;
    expect(callsFrom(g, use)).not.toContain(compute);
  });

  it("falls back to locality for an unqualified (no-receiver) call", async () => {
    // No receiver to type → the by-name/locality resolution is preserved.
    const a = await fileOf(
      `void use() { compute(); }
       void compute() {}`,
      "/repo/src/mod/a.cpp",
    );
    const g = buildGraph([a.file], a.edgeInfo);
    const use = a.file.functions.find((f) => f.name === "use")!.id!;
    const compute = a.file.functions.find((f) => f.name === "compute")!.id!;
    expect(callsFrom(g, use)).toContain(compute);
  });
});

describe("TypeRegistry", () => {
  it("resolves methods through transitive bases and reports known types", async () => {
    const f = await fileOf(
      `class A { public: void base() {} };
       class B : public A {};
       class C : public B { public: void own() {} };`,
      "/repo/src/x.cpp",
    );
    const reg = TypeRegistry.build([f.file]);
    expect(reg.isKnownType("A")).toBe(true);
    expect(reg.isKnownType("C")).toBe(true);
    expect(reg.isKnownType("Nope")).toBe(false);

    const aBase = f.file.functions.find((fn) => fn.name === "base")!.id!;
    // C inherits base() from A through B.
    expect(reg.resolveMethod("C", "base")).toEqual([aBase]);
    // A method that exists nowhere in the hierarchy resolves to nothing.
    expect(reg.resolveMethod("C", "ghost")).toEqual([]);
  });

  it("resolves data-member field types through the hierarchy", async () => {
    const f = await fileOf(
      `class Base { protected: Vec3 origin_; };
       class Widget : public Base { std::vector<Sprite*> sprites_; int n_; };`,
      "/repo/src/x.cpp",
    );
    const reg = TypeRegistry.build([f.file]);
    expect(reg.fieldType("Widget", "sprites_")).toEqual({ type: "vector", elementType: "Sprite" });
    // Inherited from Base.
    expect(reg.fieldType("Widget", "origin_")?.type).toBe("Vec3");
    // Primitive members are not recorded (cannot name a class).
    expect(reg.fieldType("Widget", "n_")).toBeNull();
    expect(reg.fieldType("Widget", "missing")).toBeNull();
  });

  it("clone() is independent of the source registry", async () => {
    const f = await fileOf("class A { public: void m() {} };", "/repo/src/a.cpp");
    const reg = TypeRegistry.build([f.file]);
    const copy = reg.clone();
    const g = await fileOf("class Z { public: void z() {} };", "/repo/src/z.cpp");
    copy.addFiles([g.file]);
    expect(copy.isKnownType("Z")).toBe(true);
    expect(reg.isKnownType("Z")).toBe(false); // original unaffected
  });
});
