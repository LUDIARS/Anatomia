import { describe, expect, it } from "vitest";
import { rulesOf } from "./helpers.js";

describe("placement rules", () => {
  it("flags a declaration far from its first use", async () => {
    const filler = Array.from({ length: 5 }, (_, i) => `  step(${i});`);
    const src = ["void run() {", "  int total = 0;", ...filler, "  use(total);", "}"].join("\n");
    expect(await rulesOf(src, "placement/declaration-distance", { thresholds: { declarationDistance: 3 } })).toEqual([
      "placement/declaration-distance@2",
    ]);
    expect(await rulesOf(src, "placement/declaration-distance", { thresholds: { declarationDistance: 10 } })).toEqual([]);
  });

  it("flags a local used only inside one nested block", async () => {
    const src = "void run(bool ready) {\n  int count = 0;\n  if (ready) {\n    use(count);\n  }\n}";
    expect(await rulesOf(src, "placement/narrow-scope")).toEqual(["placement/narrow-scope@2"]);
  });

  it("does not suggest moving a declaration into a loop body or when used outside", async () => {
    const loop = "void run(int n) {\n  int sum = 0;\n  for (int i = 0; i < n; i++) {\n    sum += i;\n  }\n}";
    expect(await rulesOf(loop, "placement/narrow-scope")).toEqual([]);
    const both = "void run(bool ready) {\n  int count = 0;\n  if (ready) {\n    use(count);\n  }\n  use(count);\n}";
    expect(await rulesOf(both, "placement/narrow-scope")).toEqual([]);
  });
});
