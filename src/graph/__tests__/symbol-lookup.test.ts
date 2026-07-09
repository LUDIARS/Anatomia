import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "../../dag/parser.js";
import { extractFunctions } from "../../dag/extract.js";
import { normalize } from "../../dag/normalize.js";
import { assignAnchorId } from "../../dag/hash.js";
import { buildFileNode } from "../../dag/merkle.js";
import type { AnalysisContext } from "../../core.js";
import { buildGraph, extractEdgeInfo } from "../build.js";
import { InMemoryCodeGraph } from "../in-memory.js";
import { buildSymbolIndex, calleesOf, callersOf, findSymbol } from "../symbol-lookup.js";

const SRC = `
int gamma() { return 1; }
int beta() { return gamma(); }
int alpha() { return beta(); }
int alphabet() { return 2; }
`;

let ctx: AnalysisContext;

beforeAll(async () => {
  const tree = await parse(SRC, "cpp");
  const functions = extractFunctions(tree, SRC, "/repo/src/main.cpp");
  for (const fn of functions) assignAnchorId(fn, normalize(fn.bodyAst));
  const file = buildFileNode("/repo/src/main.cpp", functions);
  const edgeInfo = extractEdgeInfo([file]);
  tree.delete();
  ctx = {
    repoPath: "/repo",
    graph: new InMemoryCodeGraph(buildGraph([file], edgeInfo)),
    files: [file],
    functions,
  };
});

describe("symbol lookup", () => {
  it("finds exact symbols with call fan counts", async () => {
    const hits = await findSymbol(buildSymbolIndex(ctx.functions), ctx.graph, "beta");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.name).toBe("beta");
    expect(hits[0]!.fanIn).toBe(1);
    expect(hits[0]!.fanOut).toBe(1);
  });

  it("falls back from exact to substring when exact has no hits", async () => {
    const hits = await findSymbol(buildSymbolIndex(ctx.functions), ctx.graph, "alph");
    expect(hits.map((h) => h.name)).toEqual(["alpha", "alphabet"]);
  });

  it("lists callers and callees by symbol name", async () => {
    const callers = await callersOf(ctx, ctx.graph, "beta");
    expect(callers.map((h) => h.name)).toEqual(["alpha"]);

    const callees = await calleesOf(ctx, ctx.graph, "beta");
    expect(callees.map((h) => h.name)).toEqual(["gamma"]);
  });
});
