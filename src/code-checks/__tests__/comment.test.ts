import { describe, expect, it } from "vitest";
import { rulesOf } from "./helpers.js";

describe("comment rules", () => {
  it("flags undocumented public declarations in headers only", async () => {
    const header = [
      "/// Holds a player's score.",
      "class Score {",
      "public:",
      "  /// Adds points.",
      "  void add(int points);",
      "  int total() const;",
      "private:",
      "  void recompute();",
      "};",
      "",
      "int helper(int value);",
      "",
      "// Formats a score for display.",
      "template <typename T>",
      "std::string format(T value);",
    ].join("\n");
    expect(await rulesOf(header, "comment/missing-doc", { file: "score.hpp" })).toEqual([
      "comment/missing-doc@6",
      "comment/missing-doc@11",
    ]);
    expect(await rulesOf(header, "comment/missing-doc", { file: "score.cpp" })).toEqual([]);
  });

  it("flags an undocumented complex function, not a commented one", async () => {
    const body = "{ if (a) { if (b) { if (c) { g(); } } } }";
    const bare = `void run(bool a, bool b, bool c) ${body}`;
    expect(await rulesOf(bare, "comment/undocumented-complex", { thresholds: { commentRequiredComplexity: 4 } })).toEqual([
      "comment/undocumented-complex@1",
    ]);
    const documented = `// Runs g only when all three gates are open.\nvoid run(bool a, bool b, bool c) ${body}`;
    expect(await rulesOf(documented, "comment/undocumented-complex", { thresholds: { commentRequiredComplexity: 4 } })).toEqual([]);
  });

  it("does not ask for comments on defaulted, deleted, destructor or operator members", async () => {
    const header = [
      "/// A 3D vector.",
      "struct Vec {",
      "  Vec() = default;",
      "  Vec(const Vec&) = delete;",
      "  ~Vec();",
      "  Vec operator+(const Vec& other) const;",
      "};",
    ].join("\n");
    expect(await rulesOf(header, "comment/missing-doc", { file: "vec.hpp" })).toEqual([]);
  });

  it("does not flag a line-comment block that introduces a usage example", async () => {
    const src = ["// Usage:", "//   Builder b;", "//   b.add(1);", "//   b.build();", "void build();"].join("\n");
    expect(await rulesOf(src, "comment/commented-out-code")).toEqual([]);
  });

  it("flags commented-out code once per block but not prose or doc examples", async () => {
    const src = [
      "// int legacy = compute();",
      "// legacy += 1;",
      "",
      "// Explains why the cache is rebuilt here.",
      "/** Example:",
      " * @code",
      " * run();",
      " * @endcode",
      " */",
      "void run();",
    ].join("\n");
    expect(await rulesOf(src, "comment/commented-out-code")).toEqual(["comment/commented-out-code@1"]);
  });
});
