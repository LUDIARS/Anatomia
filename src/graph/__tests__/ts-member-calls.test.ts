/**
 * TypeScript のメソッド呼び出しが辺になること。
 *
 * `terminalName` は C++ の `field_expression` と C# の `member_access_expression` しか
 * 見ておらず、 **TS/JS の `member_expression` を扱っていなかった**。 その結果
 * `extractCallSite` が null を返し、 呼び出しが `unresolved` にすら載らずに消える。
 * 辺が 1 本も張られないので、 TS リポではメソッドが軒並み orphan (fanIn 0) になり、
 * 「呼ばれていない = 死にコード」と誤って報告されていた (Memoria #2024 / #1670)。
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../dag/parser.js";
import { extractFunctions } from "../../dag/extract.js";
import { normalize } from "../../dag/normalize.js";
import { assignAnchorId } from "../../dag/hash.js";
import { buildFileNode } from "../../dag/merkle.js";
import { buildGraph, extractEdgeInfo } from "../build.js";

async function graphOf(...sources: Array<{ path: string; src: string }>) {
  const files = [];
  for (const { path, src } of sources) {
    const tree = await parse(src, "typescript");
    const fns = extractFunctions(tree, src, path);
    for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst!));
    files.push(buildFileNode(path, fns));
    tree.delete();
  }
  const edgeInfo = extractEdgeInfo(files);
  const graph = buildGraph(files, edgeInfo);
  const nameOf = new Map([...graph.nodes.values()].map((n) => [n.id, n.name]));
  return {
    graph,
    calls: (graph.edges ?? [])
      .filter((e) => e.kind === "calls")
      .map((e) => `${nameOf.get(e.from)}->${nameOf.get(e.to)}`)
      .sort(),
  };
}

describe("TypeScript のメソッド呼び出し", () => {
  it("this 越しの呼び出しが辺になる", async () => {
    const { calls } = await graphOf({ path: "src/a.ts", src: `
export class Widget {
  render(): number { return 1; }
  self(): number { return this.render(); }
}
` });
    expect(calls).toContain("self->render");
  });

  it("ローカル変数越しの呼び出しが辺になる", async () => {
    const { calls } = await graphOf({ path: "src/a.ts", src: `
export class Widget { render(): number { return 1; } }
export function caller(): number {
  const w = new Widget();
  return w.render();
}
` });
    expect(calls).toContain("caller->render");
  });

  it("依存注入 (フィールド越し) の呼び出しが辺になる", async () => {
    // これが落ちていたのが実害の中心。 DI で書いたコードほど orphan と報告されていた。
    const { calls } = await graphOf({ path: "src/a.ts", src: `
export class Widget { render(): number { return 1; } }
export interface Deps { widget: Widget; }
export function caller(deps: Deps): number { return deps.widget.render(); }
` });
    expect(calls).toContain("caller->render");
  });

  it("型付き引数越しの呼び出しが辺になる", async () => {
    const { calls } = await graphOf({ path: "src/a.ts", src: `
export class Widget { render(): number { return 1; } }
export function caller(w: Widget): number { return w.render(); }
` });
    expect(calls).toContain("caller->render");
  });

  it("識別子でない受け手は同名のリポ内関数へ繋がない", async () => {
    // `"str".replace()` のような呼び出しを自由関数と同じ緩い解決に落とすと、
    // 同名のリポ内関数へ phantom 辺が張られる (実測で db/schema.ts の replace と繋がった)。
    // 同一ファイル / 同一ディレクトリは locality 規則で拾うのが既存の仕様なので、
    // ここで見るのは **ディレクトリを跨いだ** phantom。
    const { graph, calls } = await graphOf(
      { path: "src/db/schema.ts", src: `export function replace(): string { return ""; }` },
      { path: "src/pr/listing.ts", src: `export function caller(): string { return "abc".replace("a", "b"); }` },
    );
    expect(calls).not.toContain("caller->replace");
    expect(graph.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ calleeName: "replace", reason: "unresolved-receiver" }),
      ]),
    );
  });

  it("型不明のメンバー呼び出しが後続の自由関数呼び出しを隠さない", async () => {
    const { calls } = await graphOf(
      { path: "src/db/schema.ts", src: `export function replace(): string { return ""; }` },
      { path: "src/pr/listing.ts", src: `export function caller(): string {
  "abc".replace("a", "b");
  return replace();
}` },
    );
    expect(calls).toContain("caller->replace");
  });

  it("自由関数の呼び出しは従来どおり辺になる", async () => {
    const { calls } = await graphOf({ path: "src/a.ts", src: `
export function target(): number { return 1; }
export function caller(): number { return target(); }
` });
    expect(calls).toContain("caller->target");
  });
});
