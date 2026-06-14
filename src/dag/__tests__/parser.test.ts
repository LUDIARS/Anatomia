import { describe, it, expect } from "vitest";
import { parse } from "../parser.js";

const CPP = "int add(int a, int b) {\n  return a + b;\n}";
const CS =
  "class C {\n  public int Add(int a, int b) { return a + b; }\n}";

describe("T03 parser", () => {
  it("parses C++ into a non-error tree with a function_definition", async () => {
    const tree = await parse(CPP, "cpp");
    expect(tree.rootNode.hasError).toBe(false);
    const fns = tree.rootNode.descendantsOfType("function_definition");
    expect(fns.length).toBe(1);
    tree.delete();
  });

  it("parses C# into a non-error tree with a method_declaration", async () => {
    const tree = await parse(CS, "c_sharp");
    expect(tree.rootNode.hasError).toBe(false);
    const methods = tree.rootNode.descendantsOfType("method_declaration");
    expect(methods.length).toBe(1);
    tree.delete();
  });

  it("is idempotent across repeated init (cached language)", async () => {
    const a = await parse(CPP, "cpp");
    const b = await parse(CPP, "cpp");
    expect(a.rootNode.type).toBe(b.rootNode.type);
    a.delete();
    b.delete();
  });
});
