import { describe, expect, it } from "vitest";
import { parseCodeCheckConfig } from "../config.js";
import { defaultSeverities } from "../families.js";
import { runCodeChecks } from "../run.js";
import { DEFAULT_CONFIG } from "../config.js";

const known = new Set(defaultSeverities().keys());

describe("code-check configuration", () => {
  it("merges thresholds over the defaults", () => {
    const config = parseCodeCheckConfig({ thresholds: { cognitiveComplexity: 25 } }, known);
    expect(config.thresholds.cognitiveComplexity).toBe(25);
    expect(config.thresholds.parameterCount).toBe(DEFAULT_CONFIG.thresholds.parameterCount);
  });

  it("rejects unknown rules, thresholds, fields and severities instead of ignoring them", () => {
    expect(() => parseCodeCheckConfig({ disabledRules: ["memory/nope"] }, known)).toThrow(/unknown rule/);
    expect(() => parseCodeCheckConfig({ thresholds: { depth: 3 } }, known)).toThrow(/unknown threshold/);
    expect(() => parseCodeCheckConfig({ thresholds: { functionLength: -1 } }, known)).toThrow(/non-negative/);
    expect(() => parseCodeCheckConfig({ extra: true }, known)).toThrow(/unknown field/);
    expect(() => parseCodeCheckConfig({ severity: { "memory/raw-new": "fatal" } }, known)).toThrow(/severity/);
  });
});

describe("runCodeChecks", () => {
  it("applies disabled rules and severity overrides and totals by severity", async () => {
    const src = "void f() { int* p = new int(1); delete p; }";
    const config = { ...DEFAULT_CONFIG, disabledRules: ["memory/raw-delete"], severity: { "memory/raw-new": "info" as const } };
    const report = await runCodeChecks([{ file: "a.cpp", text: src }], config);
    const memory = report.findings.filter((f) => f.category === "memory");
    expect(memory.map((f) => [f.rule, f.severity])).toEqual([["memory/raw-new", "info"]]);
    expect(report.totals.error).toBe(0);
    expect(report.version).toBe(1);
  });

  it("reports files with syntax errors while still checking them", async () => {
    const report = await runCodeChecks([{ file: "broken.cpp", text: "void f( { int* p = new int; }" }]);
    expect(report.parseErrors).toEqual(["broken.cpp"]);
  });

  it("orders findings by file, line, column and rule", async () => {
    const report = await runCodeChecks([
      { file: "b.cpp", text: "void f() { delete q; }" },
      { file: "a.cpp", text: "void f() { delete q; }" },
    ]);
    const files = report.findings.map((f) => f.file);
    expect(files).toEqual([...files].sort());
  });
});
