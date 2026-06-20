import { describe, it, expect } from "vitest";
import { parse } from "../parser.js";
import { extractFunctions } from "../extract.js";

async function names(src: string, lang: "cpp" | "c_sharp"): Promise<string[]> {
  const tree = await parse(src, lang);
  const fns = extractFunctions(tree, src, "/x.cpp");
  tree.delete();
  return fns.map((f) => f.name).sort();
}

describe("T04 extractFunctions", () => {
  it("extracts top-level C++ functions and class methods", async () => {
    const src =
      "int free(int a){ return a; }\n" +
      "struct S {\n  int method(int b){ return b; }\n};";
    expect(await names(src, "cpp")).toEqual(["free", "method"]);
  });

  it("names a reference-returning method (unwraps reference_declarator)", async () => {
    // `const std::vector<int>& items()` wraps its function_declarator in a
    // reference_declarator (positional child, no `declarator` field) — the name
    // must still resolve to `items`, not `<anonymous>`.
    const src = "struct S {\n  const std::vector<int>& items() const { return v_; }\n};";
    expect(await names(src, "cpp")).toContain("items");
  });

  it("extracts C++ overloads as separate nodes", async () => {
    const src =
      "int f(int a){ return a; }\n" +
      "int f(int a, int b){ return a + b; }";
    const tree = await parse(src, "cpp");
    const fns = extractFunctions(tree, src);
    tree.delete();
    expect(fns.length).toBe(2);
    expect(fns[0]!.signature).not.toBe(fns[1]!.signature);
  });

  it("extracts C# methods, constructors, and local functions", async () => {
    const src =
      "class C {\n" +
      "  public C() { x = 1; }\n" +
      "  public int Add(int a, int b) { return a + b; }\n" +
      "  void M() { int Inner(int z) { return z; } Inner(3); }\n" +
      "}";
    expect(await names(src, "c_sharp")).toEqual(["Add", "C", "Inner", "M"]);
  });

  it("records signature without the body and a body subtree", async () => {
    const src = "int add(int a, int b) {\n  return a + b;\n}";
    const tree = await parse(src, "cpp");
    const [fn] = extractFunctions(tree, src);
    expect(fn!.name).toBe("add");
    expect(fn!.signature).toContain("int add(int a, int b)");
    expect(fn!.signature).not.toContain("return");
    expect(fn!.bodyAst.type).toBe("compound_statement");
    tree.delete();
  });

  it("skips body-less declarations", async () => {
    const src = "int decl_only(int a);\nint with_body(int a){ return a; }";
    const tree = await parse(src, "cpp");
    const fns = extractFunctions(tree, src);
    tree.delete();
    expect(fns.map((f) => f.name)).toEqual(["with_body"]);
  });
});
