import { describe, it, expect } from "vitest";
import {
  measureCorpus,
  type SameMeaningCase,
  type StructureCase,
} from "../measure.js";

// --- corpus: same-meaning pairs (MUST hash identically) ---------------------

const sameMeaning: SameMeaningCase[] = [
  // formatting-only
  {
    category: "formatting",
    name: "add-spacing",
    base: "int add(int a, int b) {\n  int r = a + b;\n  return r;\n}",
    variant: "int add(int a,int b){int r=a+b;return r;}",
  },
  {
    category: "formatting",
    name: "loop-bracing",
    base: "int sum(int n) {\n  int t = 0;\n  for (int i = 0; i < n; i++) {\n    t += i;\n  }\n  return t;\n}",
    variant:
      "int sum(int n){int t=0;for(int i=0;i<n;i++){t+=i;}return t;}",
  },
  {
    category: "formatting",
    name: "indent",
    base: "void p() {\n        foo();\n        bar();\n}",
    variant: "void p() {\nfoo();\nbar();\n}",
  },
  // comment-only
  {
    category: "comment",
    name: "line-comments",
    base: "int add(int a, int b) {\n  int r = a + b;\n  return r;\n}",
    variant:
      "int add(int a, int b) {\n  // compute sum\n  int r = a + b; // store\n  return r; /* done */\n}",
  },
  {
    category: "comment",
    name: "block-comment",
    base: "void run() {\n  step1();\n  step2();\n}",
    variant:
      "void run() {\n  /* phase one */\n  step1();\n  /* phase two */\n  step2();\n}",
  },
  // local-var rename
  {
    category: "local_rename",
    name: "rename-local",
    base: "int add(int a, int b) {\n  int result = a + b;\n  return result;\n}",
    variant: "int add(int a, int b) {\n  int total = a + b;\n  return total;\n}",
  },
  {
    category: "local_rename",
    name: "rename-param-and-local",
    base: "int mul(int a, int b) {\n  int p = a * b;\n  return p;\n}",
    variant: "int mul(int x, int y) {\n  int q = x * y;\n  return q;\n}",
  },
  {
    category: "local_rename",
    name: "rename-loop-var",
    base: "int sum(int n) {\n  int t = 0;\n  for (int i = 0; i < n; i++) { t += i; }\n  return t;\n}",
    variant:
      "int sum(int n) {\n  int acc = 0;\n  for (int k = 0; k < n; k++) { acc += k; }\n  return acc;\n}",
  },
];

// --- corpus: structure-change pairs (MUST hash differently) -----------------

const structure: StructureCase[] = [
  {
    name: "plus-to-minus",
    base: "int add(int a, int b) {\n  int r = a + b;\n  return r;\n}",
    variant: "int add(int a, int b) {\n  int r = a - b;\n  return r;\n}",
  },
  {
    name: "add-a-statement",
    base: "void f() {\n  step1();\n}",
    variant: "void f() {\n  step1();\n  step2();\n}",
  },
  {
    name: "change-call",
    base: "void f() {\n  foo();\n}",
    variant: "void f() {\n  bar();\n}",
  },
  {
    name: "branch-added",
    base: "int g(int a) {\n  return a;\n}",
    variant: "int g(int a) {\n  if (a > 0) { return a; }\n  return 0;\n}",
  },
];

// --- corpus: 20+ distinct functions (no two may share a hash) ---------------

const distinct = [
  ["add", "int add(int a, int b) { return a + b; }"],
  ["sub", "int sub(int a, int b) { return a - b; }"],
  ["mul", "int mul(int a, int b) { return a * b; }"],
  ["div", "int divi(int a, int b) { return a / b; }"],
  ["mod", "int mod(int a, int b) { return a % b; }"],
  ["max", "int mx(int a, int b) { if (a > b) return a; return b; }"],
  ["min", "int mn(int a, int b) { if (a < b) return a; return b; }"],
  ["abs", "int ab(int a) { if (a < 0) return -a; return a; }"],
  ["square", "int sq(int a) { return a * a; }"],
  ["cube", "int cb(int a) { return a * a * a; }"],
  ["inc", "int inc(int a) { return a + 1; }"],
  ["dec", "int dec(int a) { return a - 1; }"],
  ["sumN", "int sumN(int n) { int t = 0; for (int i = 0; i < n; i++) t += i; return t; }"],
  ["prodN", "int prodN(int n) { int t = 1; for (int i = 1; i <= n; i++) t *= i; return t; }"],
  ["isEven", "bool isEven(int a) { return a % 2 == 0; }"],
  ["isOdd", "bool isOdd(int a) { return a % 2 == 1; }"],
  ["clamp", "int clamp(int a, int lo, int hi) { if (a < lo) return lo; if (a > hi) return hi; return a; }"],
  ["neg", "int neg(int a) { return -a; }"],
  ["dbl", "int dbl(int a) { return a + a; }"],
  ["half", "int half(int a) { return a / 2; }"],
  ["andOp", "bool andOp(bool a, bool b) { return a && b; }"],
  ["orOp", "bool orOp(bool a, bool b) { return a || b; }"],
  ["xorOp", "bool xorOp(bool a, bool b) { return a != b; }"],
  ["callFoo", "void callFoo() { foo(); }"],
  ["callBar", "void callBar() { bar(); }"],
].map(([name, source]) => ({ name: name!, source: source! }));

describe("T10 measureCorpus", () => {
  it("reports false-invalidation / false-collision and meets the goal", async () => {
    const report = await measureCorpus(sameMeaning, structure, distinct);

    // Pretty print so the numbers show up in test output.
    /* eslint-disable no-console */
    console.log("\n=== T10 normalization hit-rate report ===");
    console.log("same-meaning cases :", report.totalSameMeaning);
    console.log("distinct functions :", report.totalDistinct);
    console.log("falseInvalidationRate:", report.falseInvalidationRate.toFixed(4));
    console.log("falseCollisionRate  :", report.falseCollisionRate.toFixed(4));
    console.log("missedStructureChanges:", report.missedStructureChanges);
    for (const c of report.perCategory) {
      console.log(
        "  [" + c.category + "] ok=" + c.ok + "/" + c.total + " wrong=" + c.wrong,
      );
    }
    if (report.collisions.length) console.log("collisions:", report.collisions);
    console.log("==========================================\n");
    /* eslint-enable no-console */

    // GOAL: same-meaning edits never invalidate; distinct functions never collide;
    // structural edits are always detected.
    expect(report.falseInvalidationRate).toBe(0);
    expect(report.falseCollisionRate).toBe(0);
    expect(report.missedStructureChanges).toBe(0);
  });
});
