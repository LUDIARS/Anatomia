/**
 * spec_linkage gate — confidence-aware linkage (B-5).
 * minConfidence default: 0 normally (legacy: any link counts), 0.5 in strict.
 * Weakly-linked functions (links exist, all below the floor) are an advisory
 * category distinct from orphans and never fail the gate, even in strict.
 */

import { describe, it, expect } from "vitest";
import type { AnchorId, Link } from "../../types.js";
import { specLinkageGate } from "../gates/spec_linkage.js";
import { buildFromSource } from "./helpers.js";

const link = (from: string, confidence: number, evidence: Link["evidence"] = "structural"): Link => ({
  from: from as unknown as AnchorId,
  to: "clause-1",
  confidence,
  evidence,
});

async function changedFn() {
  const { graph, functions } = await buildFromSource(`void gated() {}`);
  const fn = functions[0]!;
  return { graph, functions, anchor: String(fn.id), file: String(fn.sourceRange.filePath) };
}

describe("spec_linkage minConfidence", () => {
  it("default non-strict: any-confidence link passes (legacy compat)", async () => {
    const { graph, functions, anchor } = await changedFn();
    const r = await specLinkageGate(false).run({
      changed: functions, graph, links: [link(anchor, 0.01)],
    });
    expect(r.pass).toBe(true);
    expect(r.suggestion).toBeNull();
    expect(r.anchors).toEqual([]);
  });

  it("strict default floor 0.5: a weak-only function warns but does NOT block", async () => {
    const { graph, functions, anchor } = await changedFn();
    const r = await specLinkageGate(true).run({
      changed: functions, graph, links: [link(anchor, 0.3)],
    });
    expect(r.pass).toBe(true); // weak ≠ orphan → no block
    expect(r.suggestion).toContain("Weakly-linked");
    expect(r.suggestion).not.toContain("Orphan");
    expect(r.anchors).toEqual([functions[0]!.id]);
  });

  it("strict with a link at/above the floor passes cleanly", async () => {
    const { graph, functions, anchor } = await changedFn();
    const r = await specLinkageGate(true).run({
      changed: functions, graph, links: [link(anchor, 0.5)],
    });
    expect(r.pass).toBe(true);
    expect(r.suggestion).toBeNull();
  });

  it("explicit minConfidence 0 in strict restores legacy any-link behaviour", async () => {
    const { graph, functions, anchor } = await changedFn();
    const r = await specLinkageGate(true, { minConfidence: 0 }).run({
      changed: functions, graph, links: [link(anchor, 0.1)],
    });
    expect(r.pass).toBe(true);
    expect(r.suggestion).toBeNull();
  });

  it("custom threshold splits weak vs linked around the boundary", async () => {
    const { graph, functions, anchor } = await changedFn();
    const gate = specLinkageGate(false, { minConfidence: 0.7 });
    const below = await gate.run({ changed: functions, graph, links: [link(anchor, 0.69)] });
    expect(below.pass).toBe(true);
    expect(below.suggestion).toContain("Weakly-linked");
    const at = await gate.run({ changed: functions, graph, links: [link(anchor, 0.7)] });
    expect(at.suggestion).toBeNull();
  });

  it("the best link across anchor + file-path forms decides weakness", async () => {
    const { graph, functions, anchor, file } = await changedFn();
    const r = await specLinkageGate(true).run({
      changed: functions, graph,
      links: [link(anchor, 0.2), link(file, 0.9)],
    });
    expect(r.pass).toBe(true);
    expect(r.suggestion).toBeNull(); // file-anchored 0.9 counts
  });

  it("orphans still fail in strict, and the message distinguishes the categories", async () => {
    const { graph: g1, functions: weakFns } = await buildFromSource(`void weakOne() {}`);
    const { functions: orphanFns } = await buildFromSource(`void orphanOne() {}`);
    const weakAnchor = String(weakFns[0]!.id);
    const r = await specLinkageGate(true).run({
      changed: [...weakFns, ...orphanFns],
      graph: g1,
      links: [link(weakAnchor, 0.2)],
    });
    expect(r.pass).toBe(false); // the orphan blocks
    expect(r.suggestion).toContain("Orphan code");
    expect(r.suggestion).toContain("orphanOne");
    expect(r.suggestion).toContain("Weakly-linked");
    expect(r.suggestion).toContain("weakOne");
    expect(r.anchors).toHaveLength(2);
  });
});
