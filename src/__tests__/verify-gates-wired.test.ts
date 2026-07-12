/**
 * buildVerdict — coupling_delta / convention_drift の本番配線。
 *
 * 両ゲートは入力駆動 (thresholds / siblings が無ければ無条件 pass) で、
 * buildVerdict が両フィールドを渡していなかった間は CLI/MCP 経路で常に
 * no-op だった。ここでは analyze() した実コンテキストからの verify で
 * 両ゲートが実際に発火する (= 入力が配線されている) ことを固定する。
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyze, buildVerdict } from "../core.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "mini");

describe("buildVerdict wires thresholds + siblings into the gates", () => {
  it("fires convention_drift and coupling_delta on a drifting hub function", async () => {
    expect(existsSync(FIXTURE)).toBe(true);
    const ctx = await analyze(FIXTURE, { quiet: true });

    // snake_case (siblings tick/emit/last are camel-family) + calls into every
    // existing function (coupling far above the tiny repo's p95, and absent
    // from the base graph so the delta semantics count it as an increase).
    const diff = [
      "int hub_spawn_everything(Runtime& rt, Skill& skill) {",
      "    Action a{1, 0.5f};",
      "    skill.add(a);",
      "    skill.replace(a);",
      "    int c = skill.count();",
      "    rt.tick(0.01f, skill);",
      "    rt.emit(a);",
      "    int l = rt.last();",
      "    return run_once(rt, skill) + c + l;",
      "}",
    ].join("\n");

    const verdict = await buildVerdict(ctx, diff, "runtime.cpp");
    expect(verdict.gates.length).toBe(5);

    const drift = verdict.gates.find((g) => g.gate === "convention_drift");
    expect(drift, "convention_drift gate missing").toBeDefined();
    expect(drift!.pass).toBe(false);
    expect(drift!.suggestion).toMatch(/hub_spawn_everything/);

    const coupling = verdict.gates.find((g) => g.gate === "coupling_delta");
    expect(coupling, "coupling_delta gate missing").toBeDefined();
    expect(coupling!.pass).toBe(false);
    expect(coupling!.suggestion).toMatch(/coupling/);

    // Both are WARN gates: the verdict itself still passes (no block failed).
    expect(verdict.pass).toBe(true);
  });

  it("stays quiet for a conforming small change", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });

    // camelCase-family name, single call: matches the local convention and
    // stays under the repo-relative coupling percentile.
    const diff = ["int peek(Runtime& rt) {", "    return rt.last();", "}"].join("\n");

    const verdict = await buildVerdict(ctx, diff, "runtime.cpp");
    const drift = verdict.gates.find((g) => g.gate === "convention_drift");
    const coupling = verdict.gates.find((g) => g.gate === "coupling_delta");
    expect(drift!.pass).toBe(true);
    expect(coupling!.pass).toBe(true);
  });
});
