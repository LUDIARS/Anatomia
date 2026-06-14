import { describe, it, expect } from "vitest";
import { hashFunction, assignAnchorId } from "../hash.js";
import { parse } from "../parser.js";
import { extractFunctions } from "../extract.js";
import { normalize } from "../normalize.js";
import type { FunctionNode } from "../../types.js";

describe("T06 hashFunction", () => {
  it("is deterministic and 16 hex chars (64-bit)", () => {
    const h = hashFunction("(compound_statement)");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(hashFunction("(compound_statement)")).toBe(h);
  });

  it("same normalized form -> same hash", () => {
    expect(hashFunction("X")).toBe(hashFunction("X"));
  });

  it("different normalized form -> different hash", () => {
    expect(hashFunction("X")).not.toBe(hashFunction("Y"));
  });

  it("assignAnchorId fills FunctionNode.id in place", () => {
    // bodyAst.parent = null → normalizeSignatureShape returns "(sig)" gracefully.
    const fn = {
      id: null,
      name: "f",
      signature: "void f()",
      sourceRange: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 }, filePath: "x" },
      bodyAst: { parent: null } as never,
    } as unknown as FunctionNode;
    const id = assignAnchorId(fn, "(compound_statement)");
    expect(fn.id).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// T06-sig: signature shape folded into AnchorId
// ---------------------------------------------------------------------------

/** Parse a snippet and return the AnchorId of the first extracted function. */
async function anchorOf(source: string): Promise<string> {
  const tree = await parse(source, "cpp");
  try {
    const fns = extractFunctions(tree, source);
    if (fns.length === 0) throw new Error("no function extracted");
    const fn = fns[0]!;
    return assignAnchorId(fn, normalize(fn.bodyAst));
  } finally {
    tree.delete();
  }
}

describe("T06-sig: parameter types and return type folded into AnchorId", () => {
  // ── Param rename → SAME hash ──────────────────────────────────────────────
  it("param rename (same types) does NOT change the hash", async () => {
    const a = "void foo(int a) { bar(a); }";
    const b = "void foo(int b) { bar(b); }";
    expect(await anchorOf(a)).toBe(await anchorOf(b));
  });

  it("param rename with two params does NOT change the hash", async () => {
    const a = "int add(int a, int b) { return a + b; }";
    const b = "int add(int x, int y) { return x + y; }";
    expect(await anchorOf(a)).toBe(await anchorOf(b));
  });

  // ── Param type change → DIFFERENT hash ───────────────────────────────────
  it("param type change (int → float) DOES change the hash", async () => {
    const a = "void foo(int a)   { bar(a); }";
    const b = "void foo(float a) { bar(a); }";
    expect(await anchorOf(a)).not.toBe(await anchorOf(b));
  });

  it("const-ref vs value param type DOES change the hash", async () => {
    const a = "void add(Entry entry)        { entries_.push_back(std::move(entry)); }";
    const b = "void add(CatalogEntry entry) { entries_.push_back(std::move(entry)); }";
    expect(await anchorOf(a)).not.toBe(await anchorOf(b));
  });

  // ── Return type change → DIFFERENT hash ──────────────────────────────────
  it("return type change (int → float) DOES change the hash", async () => {
    const a = "int  get() { return val_; }";
    const b = "float get() { return val_; }";
    expect(await anchorOf(a)).not.toBe(await anchorOf(b));
  });

  it("return type change (void → bool) DOES change the hash", async () => {
    const a = "void run() { step(); }";
    const b = "bool run() { step(); }";
    expect(await anchorOf(a)).not.toBe(await anchorOf(b));
  });

  // ── AdventureCube twin pattern → now DIFFERENT ────────────────────────────
  it("EffectCatalog::add vs GradeTable::add twin bodies get DIFFERENT hashes", async () => {
    // Both bodies are { entries_.push_back(std::move(entry)); } — identical.
    // Only the parameter type differs: CatalogEntry vs GradeEntry.
    const effectAdd = "void add(CatalogEntry entry) { entries_.push_back(std::move(entry)); }";
    const gradeAdd  = "void add(GradeEntry entry)   { entries_.push_back(std::move(entry)); }";
    expect(await anchorOf(effectAdd)).not.toBe(await anchorOf(gradeAdd));
  });

  it("EffectCatalog::replace vs GradeTable::replace twin bodies get DIFFERENT hashes", async () => {
    // Bodies identical; param types differ.
    const effectReplace =
      "bool replace(const CatalogEntry& entry) {\n" +
      "  for (auto& e : entries_) {\n" +
      "    if (e.id == entry.id) { e = entry; return true; }\n" +
      "  }\n" +
      "  return false;\n" +
      "}";
    const gradeReplace =
      "bool replace(const GradeEntry& entry) {\n" +
      "  for (auto& e : entries_) {\n" +
      "    if (e.id == entry.id) { e = entry; return true; }\n" +
      "  }\n" +
      "  return false;\n" +
      "}";
    expect(await anchorOf(effectReplace)).not.toBe(await anchorOf(gradeReplace));
  });
});
