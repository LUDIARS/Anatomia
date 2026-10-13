/**
 * @spec Function complexity comparison
 */
import { describe, expect, it } from "vitest";
import { buildComplexitySnapshot } from "../complexity-snapshot.js";
import type { NodeMetrics } from "../../supply/metrics.js";
import type { AnchorId, FunctionNode } from "../../types.js";
import { summarizeComplexity } from "../pr-diff.js";
import { parse } from "../../dag/parser.js";
import { extractFunctions } from "../../dag/extract.js";
import { assignAnchorId } from "../../dag/hash.js";
import { normalize } from "../../dag/normalize.js";

function fn(
  root: string,
  anchor: string | null,
  line: number,
  overrides: Partial<FunctionNode> = {},
): FunctionNode {
  return {
    id: anchor as AnchorId | null,
    name: "run",
    signature: "run(): void",
    signatureShape: "run()",
    structuralHash: anchor ?? undefined,
    sourceRange: {
      filePath: `${root}/src/a.ts`,
      start: { line, column: 0 },
      end: { line, column: 1 },
    },
    ...overrides,
  };
}

function metric(anchor: string, cyclomatic: number): NodeMetrics {
  return {
    anchor: anchor as AnchorId,
    cyclomatic,
    domainOverlap: 0,
    sharedStateFanIn: 0,
    crossDomainDepth: 0,
    fanIn: 0,
    fanOut: Math.max(0, cyclomatic - 1),
    coupling: Math.max(0, cyclomatic - 1),
  };
}

describe("buildComplexitySnapshot", () => {
  it("weights distinct occurrences of one anchor in the summary population", () => {
    const snapshot = buildComplexitySnapshot("/r", [fn("/r", "a", 1), fn("/r", "a", 2),
      fn("/r", "b", 3)], [metric("a", 5), metric("b", 2)]);
    const summary = summarizeComplexity(snapshot.functions.map((row) => ({ cyclomatic: row.value })));
    expect(summary.functions).toBe(snapshot.functions.length);
    expect(summary.averageCyclomatic).toBe(4);
    expect(summary.maximumCyclomatic).toBe(5);
  });

  it("keeps lexical declarations and registered callback slots stable across body and line edits", async () => {
    const snapshotOf = async (root: string, source: string) => {
      const tree = await parse(source, "typescript");
      try {
        const functions = extractFunctions(tree, source, `${root}/src/a.ts`);
        for (const fn of functions) assignAnchorId(fn, normalize(fn.bodyAst!), "src/a.ts");
        return buildComplexitySnapshot(root, functions, functions.map((fn) => metric(fn.id!, 1)));
      } finally { tree.delete(); }
    };
    const source = `
function first() { function run() { return 1; } }
function second() { function run() { return 1; } }
describe("first", () => { it("works", () => { return 1; }); });
describe("second", () => { it("works", () => { return 1; }); });
const left = { run() { return 1; }, onStart: () => { return 1; }, onStop: () => { return 1; } };
const right = { run() { return 1; } };
`;
    const base = await snapshotOf("/base", source);
    const head = await snapshotOf("/head", "\n\n" + source.replaceAll("return 1", "return 2"));
    expect(base.functions.map((row) => row.key)).toEqual(head.functions.map((row) => row.key));
    expect(new Set(base.functions.map((row) => row.key)).size).toBe(base.functions.length);
    const ambiguous = await snapshotOf("/head", `it("same", () => { return 1; }); it("same", () => { return 2; });`);
    expect(ambiguous.functions[0]!.key).toBe(ambiguous.functions[1]!.key);
  });
  // Excubitor 実測: 同じ component 内の `useEffect(() => …, [deps])` が同一 key になり、
  // 1 組の重複だけで PR の比較全体が旧集計へ落ちていた (Actio b02cbd38 / d73260a9)。
  it("tells callbacks apart by an identifier-only dependency array, but not by numbers", async () => {
    const keysOf = async (source: string, lang: "typescript" | "c_sharp" | "cpp" = "typescript", file = "src/a.ts") => {
      const tree = await parse(source, lang);
      try {
        const functions = extractFunctions(tree, source, `/r/${file}`);
        for (const fn of functions) assignAnchorId(fn, normalize(fn.bodyAst!), file);
        return buildComplexitySnapshot("/r", functions, functions.map((fn) => metric(fn.id!, 1))).functions.map((row) => row.key);
      } finally { tree.delete(); }
    };
    const effects = await keysOf(`function View() { useEffect(() => { load(a); }, [a]); useEffect(() => { load(b); }, [b, props.c]); }`);
    expect(new Set(effects).size).toBe(effects.length);
    // Same dependency list: the source does not distinguish them, so they stay ambiguous.
    const same = await keysOf(`function View() { useEffect(() => { load(1); }, []); useEffect(() => { load(2); }, []); }`);
    expect(same.filter((key, index) => same.indexOf(key) !== index)).toHaveLength(1);
    // A changed delay is a body-level edit, not a different registration.
    const [slow] = await keysOf(`setTimeout(() => { tick(); }, 100);`);
    const [fast] = await keysOf(`setTimeout(() => { tick(); }, 200);`);
    expect(slow).toBe(fast);
  });

  it("tells preprocessor branches apart (C# flat directives and C++ nested blocks)", async () => {
    const keysOf = async (source: string, lang: "c_sharp" | "cpp", file: string) => {
      const tree = await parse(source, lang);
      try {
        const functions = extractFunctions(tree, source, `/r/${file}`);
        for (const fn of functions) assignAnchorId(fn, normalize(fn.bodyAst!), file);
        return buildComplexitySnapshot("/r", functions, functions.map((fn) => metric(fn.id!, 1))).functions.map((row) => row.key);
      } finally { tree.delete(); }
    };
    const csharp = await keysOf(`#if TRACE\nnamespace A { static class T { static int Now() { return 1; } } }\n#else\nnamespace A { static class T { static int Now() { return 0; } } }\n#endif`, "c_sharp", "src/T.cs");
    expect(csharp).toHaveLength(2);
    expect(new Set(csharp).size).toBe(2);
    const cpp = await keysOf(`#ifdef FAST\nint run() { return 1; }\n#else\nint run() { return 0; }\n#endif`, "cpp", "src/a.cpp");
    expect(cpp).toHaveLength(2);
    expect(new Set(cpp).size).toBe(2);
  });

  it("keys survive checkout changes, body edits and line shifts", () => {
    // Different checkout root, different anchor (the body changed) and a moved
    // line: the identity must still match so the two are compared, not reported
    // as one removal plus one addition.
    const base = buildComplexitySnapshot("/base", [fn("/base", "a", 1)], [metric("a", 1)]);
    const head = buildComplexitySnapshot("/head", [fn("/head", "b", 50)], [metric("b", 4)]);

    expect(base.functions[0]!.key).toBe(head.functions[0]!.key);
    expect(head.functions[0]!.value).toBe(4);
    expect(head.functions[0]!.structuralHash).toBe("b");
  });

  it("publishes no absolute path or source text", () => {
    const snapshot = buildComplexitySnapshot(
      "/head",
      [fn("/head", "a", 50)],
      [metric("a", 3)],
    );
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain("/head");
    expect(serialized).not.toContain("src/a.ts");
    expect(serialized).not.toContain("run(");
    // Assert the row's shape exactly rather than scanning the JSON for the line
    // number: "50" occurs by chance inside a 64-char hex key about 1 run in 8.
    expect(Object.keys(snapshot.functions[0]!).sort()).toEqual([
      "key",
      "structuralHash",
      "value",
    ]);
    expect(snapshot.functions[0]!.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("separates functions that differ only by enclosing type", () => {
    // Two same-named methods on different classes in one file must not collapse
    // onto a single key, or a consumer would compare unrelated functions.
    const snapshot = buildComplexitySnapshot(
      "/r",
      [
        fn("/r", "a", 1, { enclosingType: "Alpha" }),
        fn("/r", "b", 2, { enclosingType: "Beta" }),
      ],
      [metric("a", 1), metric("b", 2)],
    );

    expect(snapshot.functions[0]!.key).not.toBe(snapshot.functions[1]!.key);
  });

  it("retains ambiguous identities in a deterministic order", () => {
    const a = fn("/r", "a", 1);
    const b = fn("/r", "b", 2);
    const snapshot = buildComplexitySnapshot("/r", [a, b], [metric("a", 5), metric("b", 2)]);

    // True overloads share an identity; the spec forbids consumers pairing them,
    // so both rows survive — sorted by value to keep the output stable.
    expect(snapshot.functions).toHaveLength(2);
    expect(snapshot.functions[0]!.key).toBe(snapshot.functions[1]!.key);
    expect(snapshot.functions.map((row) => row.value)).toEqual([2, 5]);
    expect(buildComplexitySnapshot("/r", [b, a], [metric("a", 5), metric("b", 2)]))
      .toEqual(snapshot);
  });

  it("skips unhashed functions rather than failing on them", () => {
    // Unhashed functions are never graph nodes, so they never have a metric.
    // Both spellings of "unhashed" must be skipped, not treated as missing data.
    expect(buildComplexitySnapshot("/r", [fn("/r", null, 1)], []).functions).toEqual([]);
    expect(
      buildComplexitySnapshot("/r", [fn("/r", null, 1, { id: undefined })], []).functions,
    ).toEqual([]);
    expect(buildComplexitySnapshot("/r", [], []).functions).toEqual([]);
  });

  it("names the function when a hashed function has no metric", () => {
    expect(() => buildComplexitySnapshot("/r", [fn("/r", "a", 7)], [])).toThrow(
      /Missing function complexity metric for "run" \(src\/a\.ts:7\)/,
    );
  });
});
