/**
 * T03/T04/T05/T06 — TypeScript language frontend tests.
 *
 * Covers:
 *   - parse() accepts "typescript" and "tsx"
 *   - extractFunctions() handles TS function forms
 *   - normalize() alpha-renames TS locals/params
 *   - hash invariants: rename → same; type-change → different; body-change → different
 */

import { describe, it, expect } from "vitest";
import { parse } from "../parser.js";
import { extractFunctions } from "../extract.js";
import { normalize } from "../normalize.js";
import { assignAnchorId } from "../hash.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function names(src: string, lang: "typescript" | "tsx" = "typescript"): Promise<string[]> {
  const tree = await parse(src, lang);
  const fns = extractFunctions(tree, src, "/x.ts");
  tree.delete();
  return fns.map((f) => f.name).sort();
}

/** Return the AnchorId of the first extracted function in a TS snippet. */
async function anchorOf(src: string, lang: "typescript" | "tsx" = "typescript"): Promise<string> {
  const tree = await parse(src, lang);
  try {
    const fns = extractFunctions(tree, src, "/x.ts");
    if (fns.length === 0) throw new Error("no function extracted from: " + src.slice(0, 60));
    const fn = fns[0]!;
    return assignAnchorId(fn, normalize(fn.bodyAst));
  } finally {
    tree.delete();
  }
}

async function normOf(src: string, lang: "typescript" | "tsx" = "typescript"): Promise<string> {
  const tree = await parse(src, lang);
  const fns = extractFunctions(tree, src, "/x.ts");
  const out = normalize(fns[0]!.bodyAst);
  tree.delete();
  return out;
}

// ---------------------------------------------------------------------------
// T03: parser accepts TypeScript / TSX
// ---------------------------------------------------------------------------

describe("T03 parser — TypeScript", () => {
  it("parses a TS snippet without errors and finds function_declaration", async () => {
    const src = "function greet(name: string): string { return name; }";
    const tree = await parse(src, "typescript");
    expect(tree.rootNode.hasError).toBe(false);
    const fns = tree.rootNode.descendantsOfType("function_declaration");
    expect(fns.length).toBe(1);
    tree.delete();
  });

  it("parses a TSX snippet without errors", async () => {
    const src = "const A = () => { return 1; };";
    const tree = await parse(src, "tsx");
    expect(tree.rootNode.hasError).toBe(false);
    tree.delete();
  });
});

// ---------------------------------------------------------------------------
// T04: function extraction for TypeScript forms
// ---------------------------------------------------------------------------

describe("T04 extractFunctions — TypeScript", () => {
  it("extracts top-level function_declaration", async () => {
    const src = "function add(a: number, b: number): number { return a + b; }";
    expect(await names(src)).toContain("add");
  });

  it("extracts class method_definition and constructor", async () => {
    const src = `
      class Calc {
        constructor(private val: number) { this.val = val; }
        multiply(x: number, y: number): number { return x * y; }
      }
    `;
    const ns = await names(src);
    expect(ns).toContain("multiply");
    expect(ns).toContain("constructor");
  });

  it("extracts arrow_function bound to const with inferred name", async () => {
    const src = "const add = (a: number, b: number): number => { return a + b; };";
    expect(await names(src)).toContain("add");
  });

  it("extracts function_expression bound to const", async () => {
    const src = "const greet = function(name: string): string { return name; };";
    expect(await names(src)).toContain("greet");
  });

  it("skips body-less overload declarations", async () => {
    const src =
      "function foo(a: number): number;\n" +
      "function foo(a: number): number { return a; }";
    const ns = await names(src);
    // Only the implementation should be extracted (one entry).
    expect(ns.filter((n) => n === "foo").length).toBe(1);
  });

  it("records body as statement_block and signature without the body", async () => {
    const src = "function add(a: number, b: number): number { return a + b; }";
    const tree = await parse(src, "typescript");
    const fns = extractFunctions(tree, src, "/x.ts");
    const fn = fns[0]!;
    expect(fn.name).toBe("add");
    expect(fn.bodyAst.type).toBe("statement_block");
    expect(fn.signature).toContain("add");
    expect(fn.signature).not.toContain("return");
    tree.delete();
  });
});

// ---------------------------------------------------------------------------
// T05: normalization alpha-renames TS locals and params
// ---------------------------------------------------------------------------

describe("T05 normalize — TypeScript", () => {
  const base =
    "function add(a: number, b: number): number { const result = a + b; return result; }";

  it("ignores formatting (whitespace/newlines)", async () => {
    const compact = "function add(a:number,b:number):number{const result=a+b;return result;}";
    expect(await normOf(compact)).toBe(await normOf(base));
  });

  it("ignores comments", async () => {
    const commented =
      "function add(a: number, b: number): number { /* sum */ const result = a + b; return result; }";
    expect(await normOf(commented)).toBe(await normOf(base));
  });

  it("alpha-normalizes local variable renames (const total → same as const result)", async () => {
    const renamed =
      "function add(a: number, b: number): number { const total = a + b; return total; }";
    expect(await normOf(renamed)).toBe(await normOf(base));
  });

  it("alpha-normalizes parameter renames (x, y → same as a, b)", async () => {
    const renamed =
      "function add(x: number, y: number): number { const result = x + y; return result; }";
    expect(await normOf(renamed)).toBe(await normOf(base));
  });

  it("produces a DIFFERENT form when the body logic changes", async () => {
    const changed =
      "function add(a: number, b: number): number { const result = a - b; return result; }";
    expect(await normOf(changed)).not.toBe(await normOf(base));
  });

  it("canonical string contains positional indices $v0 and $p0", async () => {
    const out = await normOf(base);
    expect(out).toContain("$v0");
    expect(out).toContain("$p0");
    expect(out).not.toContain("result");
  });
});

// ---------------------------------------------------------------------------
// T06-TS: hash invariants for TypeScript
// ---------------------------------------------------------------------------

describe("T06 hash invariants — TypeScript", () => {
  // ── Param rename → SAME hash ──────────────────────────────────────────────
  it("param rename (same types) does NOT change the hash", async () => {
    const a = "function foo(name: string): string { const msg = 'hi ' + name; return msg; }";
    const b = "function foo(n: string): string { const msg = 'hi ' + n; return msg; }";
    expect(await anchorOf(a)).toBe(await anchorOf(b));
  });

  it("param rename with two typed params does NOT change the hash", async () => {
    const a = "function add(a: number, b: number): number { const r = a + b; return r; }";
    const b = "function add(x: number, y: number): number { const r = x + y; return r; }";
    expect(await anchorOf(a)).toBe(await anchorOf(b));
  });

  // ── Local rename → SAME hash ──────────────────────────────────────────────
  it("local variable rename does NOT change the hash", async () => {
    const a = "function f(x: number): number { const result = x * 2; return result; }";
    const b = "function f(x: number): number { const val = x * 2; return val; }";
    expect(await anchorOf(a)).toBe(await anchorOf(b));
  });

  // ── Comment → SAME hash ───────────────────────────────────────────────────
  it("comment insertion does NOT change the hash", async () => {
    const a = "function foo(x: number): number { return x + 1; }";
    const b = "function foo(x: number): number { /* probe */ return x + 1; }";
    expect(await anchorOf(a)).toBe(await anchorOf(b));
  });

  // ── Param type change → DIFFERENT hash ───────────────────────────────────
  it("param type change (number → string) DOES change the hash", async () => {
    const a = "function foo(x: number): void { console.log(x); }";
    const b = "function foo(x: string): void { console.log(x); }";
    expect(await anchorOf(a)).not.toBe(await anchorOf(b));
  });

  // ── Return type change → DIFFERENT hash ──────────────────────────────────
  it("return type change (number → string) DOES change the hash", async () => {
    const a = "function get(): number { return 1; }";
    const b = "function get(): string { return 1; }";
    expect(await anchorOf(a)).not.toBe(await anchorOf(b));
  });

  // ── Body change → DIFFERENT hash ─────────────────────────────────────────
  it("body logic change DOES change the hash", async () => {
    const a = "function foo(x: number): number { return x + 1; }";
    const b = "function foo(x: number): number { return x - 1; }";
    expect(await anchorOf(a)).not.toBe(await anchorOf(b));
  });

  // ── Distinct functions → no collision ────────────────────────────────────
  it("two structurally identical functions with different param types get different hashes", async () => {
    const a = "function store(entry: CatalogEntry): void { this.entries.push(entry); }";
    const b = "function store(entry: GradeEntry): void { this.entries.push(entry); }";
    expect(await anchorOf(a)).not.toBe(await anchorOf(b));
  });

  // ── Arrow function → same invariants ─────────────────────────────────────
  it("arrow function: param rename does NOT change hash", async () => {
    const a = "const add = (a: number, b: number): number => { return a + b; };";
    const b = "const add = (x: number, y: number): number => { return x + y; };";
    expect(await anchorOf(a)).toBe(await anchorOf(b));
  });

  it("arrow function: param type change DOES change hash", async () => {
    const a = "const f = (x: number): number => { return x; };";
    const b = "const f = (x: string): string => { return x; };";
    expect(await anchorOf(a)).not.toBe(await anchorOf(b));
  });
});
