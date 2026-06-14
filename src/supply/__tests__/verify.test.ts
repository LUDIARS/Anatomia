/**
 * T29 — Tests for verify.ts + the 5 gates, including a failing-gate case.
 * The embedding client is mocked (no real API).
 */

import { describe, it, expect } from "vitest";
import { verify, buildDefaultGates } from "../verify.js";
import {
  ruleConformanceGate,
  duplicationGate,
  specLinkageGate,
  couplingDeltaGate,
  conventionDriftGate,
} from "../gates/index.js";
import type { DiffInput, DuplicationDeps } from "../gates/index.js";
import type { EmbeddingClient } from "../../spec/semantic.js";
import type { AnchorId, FunctionNode, Rule, Link } from "../../types.js";
import { buildFromSource } from "./helpers.js";
import { deriveThresholds } from "../thresholds.js";
import { computeMetrics } from "../metrics.js";

function a(id: string): AnchorId {
  return id as unknown as AnchorId;
}

// Mock embedding client: deterministic 8-dim char-bucket hash. Identical text
// embeds identically (cosine 1.0); different text differs.
const mockEmbed: EmbeddingClient = async (texts) =>
  texts.map((t) => {
    const v = new Array(8).fill(0);
    for (let i = 0; i < t.length; i++) v[i % 8] += t.charCodeAt(i);
    return v;
  });

const dupDeps: DuplicationDeps = { embed: mockEmbed, similarityThreshold: 0.99 };

function sib(id: string, name: string): FunctionNode {
  return {
    id: a(id),
    name,
    signature: `void ${name}()`,
    sourceRange: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 }, filePath: "/s.cpp" },
    bodyAst: {} as FunctionNode["bodyAst"],
  };
}

describe("T29 rule_conformance gate", () => {
  it("fails (block) when an applicable rule is violated in new code", async () => {
    const { graph, functions, idOf } = await buildFromSource(
      `void b() {} void a() { b(); }`,
    );
    const rule: Rule = {
      id: "no-a-calls-b",
      scope: "global",
      description: "a must not call b",
      predicate: {
        type: "EdgeForbidden",
        from: { namePattern: "^a$" },
        to: { namePattern: "^b$" },
        kind: "calls",
      },
      severity: "block",
    };
    const input: DiffInput = { changed: functions, graph, rules: [rule] };
    const r = await ruleConformanceGate().run(input);
    expect(r.pass).toBe(false);
    expect(r.anchors).toContain(idOf["a"]);
    expect(r.suggestion).toContain("no-a-calls-b");
  });

  it("passes when no rule is violated", async () => {
    const { graph, functions } = await buildFromSource(`void clean() {}`);
    const r = await ruleConformanceGate().run({ changed: functions, graph, rules: [] });
    expect(r.pass).toBe(true);
  });
});

describe("T29 duplication gate", () => {
  it("fails (block) when new code is too similar to an existing mechanic card", async () => {
    const { graph, functions } = await buildFromSource(`void dashSkill() {}`);
    const newText = `${functions[0]!.name} ${functions[0]!.signature}`;
    const input: DiffInput = {
      changed: functions,
      graph,
      mechanicCards: [{ mechanic: "DashSkill", text: newText }],
    };
    const r = await duplicationGate(dupDeps).run(input);
    expect(r.pass).toBe(false);
    expect(r.suggestion).toContain("DashSkill");
  });

  it("passes when nothing is similar", async () => {
    const { graph, functions } = await buildFromSource(`void uniqueThing() {}`);
    const input: DiffInput = {
      changed: functions,
      graph,
      mechanicCards: [{ mechanic: "Totally", text: "zzz different content xyz" }],
    };
    const r = await duplicationGate(dupDeps).run(input);
    expect(r.pass).toBe(true);
  });
});

describe("T29 spec_linkage gate", () => {
  it("warns on orphan code with no spec link", async () => {
    const { graph, functions } = await buildFromSource(`void orphan() {}`);
    const r = await specLinkageGate(false).run({ changed: functions, graph, links: [] });
    expect(r.pass).toBe(false);
    expect(specLinkageGate(false).severity).toBe("warn");
  });

  it("passes when linked, and block severity when strict", async () => {
    const { graph, functions } = await buildFromSource(`void linked() {}`);
    const link: Link = {
      from: functions[0]!.id as AnchorId,
      to: "spec-1",
      confidence: 1,
      evidence: "explicit",
    };
    const r = await specLinkageGate(true).run({ changed: functions, graph, links: [link] });
    expect(r.pass).toBe(true);
    expect(specLinkageGate(true).severity).toBe("block");
  });
});

describe("T29 coupling_delta gate", () => {
  it("warns when coupling exceeds the repo upper percentile", async () => {
    const src = `
      void leaf() {}
      void c1() { hub(); }
      void c2() { hub(); }
      void c3() { hub(); }
      void hub() { leaf(); }
    `;
    const { graph, functions, idOf } = await buildFromSource(src);
    const metrics = await computeMetrics(graph);
    const thresholds = deriveThresholds(metrics, { upperPercentile: 0.5 });
    const hubFn = functions.find((f) => f.name === "hub")!;
    const r = await couplingDeltaGate().run({ changed: [hubFn], graph, thresholds });
    expect(r.pass).toBe(false);
    expect(r.anchors).toContain(idOf["hub"]);
    expect(couplingDeltaGate().severity).toBe("warn");
  });

  it("passes when no thresholds provided", async () => {
    const { graph, functions } = await buildFromSource(`void x() {}`);
    const r = await couplingDeltaGate().run({ changed: functions, graph });
    expect(r.pass).toBe(true);
  });
});

describe("T29 convention_drift gate", () => {
  it("warns when a new name diverges from sibling naming style", async () => {
    const siblings = [sib("s1", "BurnEffect"), sib("s2", "PoisonEffect")];
    const changed = [sib("n1", "freeze_thing")];
    const { graph } = await buildFromSource(`void x() {}`);
    const r = await conventionDriftGate().run({ changed, graph, siblings });
    expect(r.pass).toBe(false);
    expect(r.suggestion).toMatch(/freeze_thing/);
  });

  it("passes when new code matches sibling conventions", async () => {
    const siblings = [sib("s1", "BurnEffect"), sib("s2", "PoisonEffect")];
    const changed = [sib("n1", "FreezeEffect")];
    const { graph } = await buildFromSource(`void x() {}`);
    const r = await conventionDriftGate().run({ changed, graph, siblings });
    expect(r.pass).toBe(true);
  });
});

describe("T29 verify (orchestration)", () => {
  it("verdict fails when a BLOCK gate fails, passes when only WARN fails", async () => {
    const { graph, functions, idOf } = await buildFromSource(
      `void b() {} void a() { b(); }`,
    );
    const blockingRule: Rule = {
      id: "no-a-calls-b",
      scope: "global",
      description: "a must not call b",
      predicate: {
        type: "EdgeForbidden",
        from: { namePattern: "^a$" },
        to: { namePattern: "^b$" },
        kind: "calls",
      },
      severity: "block",
    };

    const failing: DiffInput = {
      changed: functions,
      graph,
      rules: [blockingRule],
      mechanicCards: [],
      links: functions.map((f) => ({
        from: f.id as AnchorId,
        to: "s",
        confidence: 1,
        evidence: "explicit" as const,
      })),
    };
    const v1 = await verify(failing, buildDefaultGates(dupDeps));
    expect(v1.pass).toBe(false);
    expect(v1.anchors).toContain(idOf["a"]);
    expect(v1.gates.find((g) => g.gate === "rule_conformance")!.pass).toBe(false);

    const warnOnly: DiffInput = {
      changed: functions,
      graph,
      rules: [],
      mechanicCards: [],
      links: [],
    };
    const v2 = await verify(warnOnly, buildDefaultGates(dupDeps));
    expect(v2.pass).toBe(true);
    expect(v2.gates.find((g) => g.gate === "spec_linkage")!.pass).toBe(false);
    expect(v2.suggestion).toContain("spec_linkage");
  });

  it("runs all 5 gates and reports each", async () => {
    const { graph, functions } = await buildFromSource(`void solo() {}`);
    const v = await verify(
      { changed: functions, graph, rules: [], mechanicCards: [], links: [] },
      buildDefaultGates(dupDeps),
    );
    expect(v.gates.map((g) => g.gate).sort()).toEqual(
      ["convention_drift", "coupling_delta", "duplication", "rule_conformance", "spec_linkage"],
    );
  });
});
