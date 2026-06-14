import { describe, it, expect } from "vitest";
import { parse } from "../parser.js";
import { extractFunctions } from "../extract.js";
import { normalize } from "../normalize.js";

async function norm(src: string, lang: "cpp" | "c_sharp" = "cpp"): Promise<string> {
  const tree = await parse(src, lang);
  const fns = extractFunctions(tree, src);
  const out = normalize(fns[0]!.bodyAst);
  tree.delete();
  return out;
}

describe("T05 normalize", () => {
  const base = "int add(int a, int b) {\n  int result = a + b;\n  return result;\n}";

  it("ignores formatting (whitespace/newlines)", async () => {
    const formatted = "int add(int a,int b){int result=a+b;return result;}";
    expect(await norm(formatted)).toBe(await norm(base));
  });

  it("ignores comments", async () => {
    const commented =
      "int add(int a, int b) {\n  // sum\n  int result = a + b; /* c */\n  return result;\n}";
    expect(await norm(commented)).toBe(await norm(base));
  });

  it("alpha-normalizes local variable renames", async () => {
    const renamed = "int add(int a, int b) {\n  int total = a + b;\n  return total;\n}";
    expect(await norm(renamed)).toBe(await norm(base));
  });

  it("alpha-normalizes parameter renames", async () => {
    const renamed = "int add(int x, int y) {\n  int result = x + y;\n  return result;\n}";
    expect(await norm(renamed)).toBe(await norm(base));
  });

  it("produces a DIFFERENT form when the body structure changes", async () => {
    const changed = "int add(int a, int b) {\n  int result = a - b;\n  return result;\n}";
    expect(await norm(changed)).not.toBe(await norm(base));
  });

  it("keeps called function names (public symbols)", async () => {
    const callsFoo = "void m() {\n  foo();\n}";
    const callsBar = "void m() {\n  bar();\n}";
    expect(await norm(callsFoo)).not.toBe(await norm(callsBar));
  });

  it("uses positional indices $v / $p in the canonical string", async () => {
    const out = await norm(base);
    expect(out).toContain("$v0");
    expect(out).toContain("$p0");
    expect(out).not.toContain("result");
    expect(out).not.toMatch(/\(id a\)/);
  });

  it("works for C# local-rename too", async () => {
    const a = "class C { int Add(int a, int b) { int r = a + b; return r; } }";
    const b = "class C { int Add(int x, int y) { int s = x + y; return s; } }";
    expect(await norm(a, "c_sharp")).toBe(await norm(b, "c_sharp"));
  });
});
