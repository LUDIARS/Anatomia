import { describe, expect, it } from "vitest";
import { buildComplexitySnapshot } from "../complexity-snapshot.js";
import type { NodeMetrics } from "../../supply/metrics.js";
import type { AnchorId, FunctionNode } from "../../types.js";

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
