/**
 * T16 — Tests for template rules + structural matcher (template.ts, matcher.ts).
 */

import { describe, it, expect } from "vitest";
import { parse } from "../dag/parser.js";
import { extractFunctions } from "../dag/extract.js";
import { normalize } from "../dag/normalize.js";
import { assignAnchorId } from "../dag/hash.js";
import {
  compileTemplate,
  matchTemplate,
  evaluateTemplate,
  encodePattern,
} from "./template.js";
import type { FunctionNode } from "../types.js";
import type { TemplateRule as TplRule } from "./template.js";

async function functionsFrom(src: string): Promise<FunctionNode[]> {
  const tree = await parse(src, "cpp");
  const fns = extractFunctions(tree, src, "/t.cpp");
  for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst));
  // NOTE: tree intentionally kept alive (bodyAst is read by the matcher).
  return fns;
}

describe("T16 encodePattern", () => {
  it("encodes $METAVARS and ... into identifier-safe tokens", () => {
    expect(encodePattern("$SKILL.mutate($STATE)")).toBe(
      "ANATOMIA_META_SKILL.mutate(ANATOMIA_META_STATE)",
    );
    expect(encodePattern("log(...)")).toBe("log(ANATOMIA_DOTS)");
  });
});

describe("T16 compileTemplate", () => {
  it("compiles to a TemplatePredicate referencing the id", () => {
    const tpl: TplRule = {
      id: "x/no-mutate",
      pattern: "$O.mutate($A)",
      metavars: ["O", "A"],
      language: "cpp",
      positive: false,
    };
    const pred = compileTemplate(tpl);
    expect(pred.type).toBe("TemplatePredicate");
    if (pred.type === "TemplatePredicate") expect(pred.templateId).toBe("x/no-mutate");
  });
});

describe("T16 matchTemplate — structural match + metavar binding", () => {
  it("matches a direct mutate call and binds metavars", async () => {
    const fns = await functionsFrom("void bad() { player.mutate(state); }");
    const tpl: TplRule = {
      id: "t", pattern: "$O.mutate($A)", metavars: ["O", "A"], language: "cpp", positive: false,
    };
    const m = await matchTemplate(tpl, fns[0]!);
    expect(m).not.toBeNull();
    expect(m!.bindings.get("$O")).toBe("player");
    expect(m!.bindings.get("$A")).toBe("state");
  });

  it("does NOT match a different method call", async () => {
    const fns = await functionsFrom("void good() { player.transition(state); }");
    const tpl: TplRule = {
      id: "t", pattern: "$O.mutate($A)", metavars: ["O", "A"], language: "cpp", positive: false,
    };
    const m = await matchTemplate(tpl, fns[0]!);
    expect(m).toBeNull();
  });

  it("wildcard ... matches any argument list", async () => {
    const many = await functionsFrom("void a() { log(x, y, z); }");
    const none = await functionsFrom("void b() { log(); }");
    const other = await functionsFrom("void c() { other(x); }");
    const tpl: TplRule = { id: "t", pattern: "log(...)", metavars: [], language: "cpp", positive: false };
    expect(await matchTemplate(tpl, many[0]!)).not.toBeNull();
    expect(await matchTemplate(tpl, none[0]!)).not.toBeNull();
    expect(await matchTemplate(tpl, other[0]!)).toBeNull();
  });
});

describe("T16 evaluateTemplate — positive / negative polarity", () => {
  it("negative template: matching function is a violation", async () => {
    const fns = await functionsFrom(`
      void bad() { player.mutate(state); }
      void good() { player.transition(state); }
    `);
    const tpl: TplRule = {
      id: "no-mutate", pattern: "$O.mutate($A)", metavars: ["O", "A"], language: "cpp", positive: false,
    };
    const v = await evaluateTemplate(tpl, fns);
    expect(v.length).toBe(1);
    expect(v[0]!.evidence).toContain("bad");
    expect(v[0]!.severity).toBe("error");
  });

  it("positive template: non-matching function is a violation", async () => {
    const fns = await functionsFrom(`
      void withGuard() { guard.check(state); }
      void noGuard() { doStuff(); }
    `);
    const tpl: TplRule = {
      id: "needs-guard", pattern: "$G.check($S)", metavars: ["G", "S"], language: "cpp", positive: true,
    };
    const v = await evaluateTemplate(tpl, fns);
    // noGuard does not match the required template => one violation.
    expect(v.length).toBe(1);
    expect(v[0]!.evidence).toContain("noGuard");
    expect(v[0]!.severity).toBe("warning");
  });
});
