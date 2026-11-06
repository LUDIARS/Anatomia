import { describe, expect, it } from "vitest";
import { parse } from "../../dag/parser.js";
import { cognitiveComplexity, cyclomaticComplexity } from "../cognitive-complexity.js";
import { functionDefinitions } from "../syntax.js";
import { findings } from "./helpers.js";

async function measure(src: string): Promise<{ cognitive: number; cyclomatic: number }> {
  const tree = await parse(src, "cpp");
  const fn = functionDefinitions(tree.rootNode)[0]!;
  const result = { cognitive: cognitiveComplexity(fn), cyclomatic: cyclomaticComplexity(fn) };
  tree.delete();
  return result;
}

describe("cognitive complexity (SonarSource rules)", () => {
  it("scores a flat function 0", async () => {
    expect(await measure("int add(int a, int b) { return a + b; }")).toEqual({ cognitive: 0, cyclomatic: 1 });
  });

  it("adds nesting increments for nested structures", async () => {
    // if (+1), for nested once (+2), if nested twice (+3) = 6
    const src = "void f(int n) { if (n) { for (int i = 0; i < n; i++) { if (i) { g(); } } } }";
    expect((await measure(src)).cognitive).toBe(6);
  });

  it("counts else-if and else without nesting increments", async () => {
    // if +1, else if +1, else +1 = 3
    const src = "int f(int n) { if (n == 1) { return 1; } else if (n == 2) { return 2; } else { return 3; } }";
    expect(await measure(src)).toEqual({ cognitive: 3, cyclomatic: 3 });
  });

  it("counts runs of like logical operators, not each operator", async () => {
    // if +1, `a && b && c` +1, `|| d` +1 = 3
    const src = "void f(bool a, bool b, bool c, bool d) { if (a && b && c || d) { g(); } }";
    expect(await measure(src)).toEqual({ cognitive: 3, cyclomatic: 5 });
  });

  it("counts switch once and each case for cyclomatic only", async () => {
    const src = "int f(int n) { switch (n) { case 1: return 1; case 2: return 2; default: return 0; } }";
    expect(await measure(src)).toEqual({ cognitive: 1, cyclomatic: 3 });
  });

  it("adds one for direct recursion", async () => {
    const src = "int fact(int n) { return n <= 1 ? 1 : n * fact(n - 1); }";
    expect((await measure(src)).cognitive).toBe(2);
  });
});

describe("complexity rules", () => {
  it("reports each measure over its threshold with the value", async () => {
    const src = "void wide(int a1, int a2, int a3) {\n  if (a1) {\n    if (a2) { use(a3); }\n  }\n}";
    const result = (await findings(src, { thresholds: { cognitiveComplexity: 2, parameterCount: 2, functionLength: 3, cyclomaticComplexity: 2 } }))
      .filter((f) => f.category === "complexity")
      .map((f) => [f.rule, f.value, f.threshold]);
    expect(result).toEqual([
      ["complexity/cognitive", 3, 2],
      ["complexity/cyclomatic", 3, 2],
      ["complexity/function-length", 5, 3],
      ["complexity/parameter-count", 3, 2],
    ]);
  });
});
