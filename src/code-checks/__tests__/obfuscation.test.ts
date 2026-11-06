import { describe, expect, it } from "vitest";
import { rulesOf } from "./helpers.js";

describe("obfuscation rules", () => {
  it("flags short names outside the allow-list", async () => {
    const src = "int total(int p, int i) {\n  int q = p + i;\n  return q;\n}";
    expect(await rulesOf(src, "obfuscation/short-identifier")).toEqual([
      "obfuscation/short-identifier@1",
      "obfuscation/short-identifier@2",
    ]);
  });

  it("flags function-like macros beyond the per-file allowance", async () => {
    const src = "#define A1(x) (x)\n#define A2(x) (x)\n#define LIMIT 3\n";
    expect(await rulesOf(src, "obfuscation/function-macro", { thresholds: { functionMacrosPerFile: 1 } })).toEqual([
      "obfuscation/function-macro@2",
    ]);
    expect(await rulesOf(src, "obfuscation/function-macro", { thresholds: { functionMacrosPerFile: 2 } })).toEqual([]);
  });

  it("flags a nested conditional operator once, not a single one", async () => {
    const src = "int pick(int value) {\n  int single = value ? 1 : 2;\n  int nested = value > 1 ? value > 2 ? 3 : 2 : 1;\n  return single + nested;\n}";
    expect(await rulesOf(src, "obfuscation/nested-ternary")).toEqual(["obfuscation/nested-ternary@3"]);
  });

  it("accepts the one-line `case X: f(); break;` idiom", async () => {
    const src = "void run(int kind) {\n  switch (kind) {\n    case 1: start(); break;\n    default: stop(); break;\n  }\n}";
    expect(await rulesOf(src, "obfuscation/dense-line")).toEqual([]);
  });

  it("flags goto", async () => {
    const src = "void run() {\n  goto done;\ndone:\n  return;\n}";
    expect(await rulesOf(src, "obfuscation/goto")).toEqual(["obfuscation/goto@2"]);
  });

  it("flags several statements on one line and over-long lines, not a for header", async () => {
    const src = [
      "void run(int count) {",
      "  int first = 1; int second = 2;",
      "  for (int i = 0; i < count; i++) {",
      "    use(i);",
      "  }",
      `  use(${"first".padEnd(130, " ")});`,
      "}",
    ].join("\n");
    expect(await rulesOf(src, "obfuscation/dense-line")).toEqual(["obfuscation/dense-line@2"]);
    expect(await rulesOf(src, "obfuscation/long-line")).toEqual(["obfuscation/long-line@6"]);
  });
});
