import { describe, expect, it } from "vitest";
import { rulesOf } from "./helpers.js";

describe("declaration rules", () => {
  it("flags uninitialized scalars and pointers, not class types or statics", async () => {
    const src = [
      "void run() {",
      "  int count;",
      "  char* name;",
      "  std::string label;",
      "  static int calls;",
      "  use(count, name, label, calls);",
      "}",
    ].join("\n");
    expect(await rulesOf(src, "declaration/uninitialized")).toEqual([
      "declaration/uninitialized@2",
      "declaration/uninitialized@3",
    ]);
  });

  it("treats a condition declaration as initialized and leaves arrays out", async () => {
    const src = "void run(Node& node) {\n  if (const Node* child = node.find()) { use(child); }\n  char buffer[32];\n  fill(buffer);\n}";
    expect(await rulesOf(src, "declaration/uninitialized")).toEqual([]);
  });

  it("flags several variables in one declaration once", async () => {
    const src = "void run() {\n  int width = 1, height = 2;\n  use(width, height);\n}";
    expect(await rulesOf(src, "declaration/multiple-per-statement")).toEqual(["declaration/multiple-per-statement@2"]);
  });

  it("flags unused scalars but not RAII objects", async () => {
    const src = "void run(std::mutex& m) {\n  int unused = 0;\n  std::lock_guard<std::mutex> lock(m);\n}";
    expect(await rulesOf(src, "declaration/unused")).toEqual(["declaration/unused@2"]);
  });

  it("suggests const only for values that are never written or handed out", async () => {
    const src = [
      "int run(int input) {",
      "  int fixed = input * 2;",
      "  int counter = 0;",
      "  counter++;",
      "  int assigned = 1;",
      "  assigned = 3;",
      "  int passed = 4;",
      "  mutate(passed);",
      "  std::vector<int> items = {1};",
      "  items.push_back(2);",
      "  const int already = 5;",
      "  return fixed + counter + assigned + passed + already + items.size();",
      "}",
    ].join("\n");
    expect(await rulesOf(src, "declaration/const-candidate")).toEqual(["declaration/const-candidate@2"]);
  });
});
