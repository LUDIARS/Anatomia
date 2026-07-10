/**
 * Link-stability tracking (spec/stability.ts): streak transitions across
 * fingerprints, candidate extraction (non-explicit, streak >= K), the
 * ANATOMIA_LINK_PROMOTE_STREAK threshold (fail-fast on misconfiguration),
 * and the local-state roundtrip.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnchorId, Link } from "../types.js";
import {
  updateStability,
  promotionCandidates,
  promoteStreakThreshold,
  loadStability,
  saveStability,
  recordAnalysis,
  type LinkStabilityState,
} from "./stability.js";

const link = (from: string, to: string, confidence: number, evidence: Link["evidence"] = "structural"): Link => ({
  from: from as unknown as AnchorId,
  to,
  confidence,
  evidence,
});

describe("updateStability — streak transitions", () => {
  it("a new link starts at streak 1", () => {
    const state = updateStability({}, [link("a.ts", "C1", 0.6)], "fp1");
    expect(state["a.ts::C1"]).toEqual({ streak: 1, lastConfidence: 0.6, lastFingerprint: "fp1" });
  });

  it("survival across a NEW fingerprint with non-decreasing confidence bumps the streak", () => {
    let state = updateStability({}, [link("a.ts", "C1", 0.6)], "fp1");
    state = updateStability(state, [link("a.ts", "C1", 0.6)], "fp2");
    state = updateStability(state, [link("a.ts", "C1", 0.7)], "fp3");
    expect(state["a.ts::C1"]).toMatchObject({ streak: 3, lastConfidence: 0.7 });
  });

  it("the same fingerprint is not new evidence — streak unchanged", () => {
    let state = updateStability({}, [link("a.ts", "C1", 0.6)], "fp1");
    state = updateStability(state, [link("a.ts", "C1", 0.9)], "fp1");
    expect(state["a.ts::C1"]).toMatchObject({ streak: 1, lastConfidence: 0.6 });
  });

  it("a confidence drop resets the streak to 1", () => {
    let state = updateStability({}, [link("a.ts", "C1", 0.6)], "fp1");
    state = updateStability(state, [link("a.ts", "C1", 0.7)], "fp2");
    state = updateStability(state, [link("a.ts", "C1", 0.5)], "fp3");
    expect(state["a.ts::C1"]).toMatchObject({ streak: 1, lastConfidence: 0.5 });
  });

  it("a disappeared link's entry is deleted", () => {
    let state = updateStability({}, [link("a.ts", "C1", 0.6), link("b.ts", "C2", 0.5)], "fp1");
    state = updateStability(state, [link("b.ts", "C2", 0.5)], "fp2");
    expect(state["a.ts::C1"]).toBeUndefined();
    expect(state["b.ts::C2"]).toMatchObject({ streak: 2 });
  });

  it("explicit links are not tracked", () => {
    const state = updateStability({}, [link("a.ts", "C1", 1.0, "explicit")], "fp1");
    expect(state).toEqual({});
  });
});

describe("promotionCandidates", () => {
  const state: LinkStabilityState = {
    "a.ts::C1": { streak: 3, lastConfidence: 0.6, lastFingerprint: "fp3" },
    "b.ts::C2": { streak: 2, lastConfidence: 0.5, lastFingerprint: "fp3" },
    "c.ts::C3": { streak: 5, lastConfidence: 0.9, lastFingerprint: "fp3" },
  };
  const links = [
    link("a.ts", "C1", 0.6),
    link("b.ts", "C2", 0.5),
    link("c.ts", "C3", 0.9, "semantic"),
    link("d.ts", "C4", 1.0, "explicit"),
  ];

  it("returns non-explicit links with streak >= K, highest streak first", () => {
    const out = promotionCandidates(state, links, 3);
    expect(out.map((c) => String(c.link.from))).toEqual(["c.ts", "a.ts"]);
    expect(out.map((c) => c.streak)).toEqual([5, 3]);
  });

  it("never proposes explicit links even at a high streak", () => {
    const withExplicit: LinkStabilityState = {
      ...state,
      "d.ts::C4": { streak: 9, lastConfidence: 1.0, lastFingerprint: "fp3" },
    };
    const out = promotionCandidates(withExplicit, links, 3);
    expect(out.some((c) => String(c.link.from) === "d.ts")).toBe(false);
  });
});

describe("promoteStreakThreshold (ANATOMIA_LINK_PROMOTE_STREAK)", () => {
  const prior = process.env["ANATOMIA_LINK_PROMOTE_STREAK"];
  afterEach(() => {
    if (prior === undefined) delete process.env["ANATOMIA_LINK_PROMOTE_STREAK"];
    else process.env["ANATOMIA_LINK_PROMOTE_STREAK"] = prior;
  });

  it("defaults to 3", () => {
    delete process.env["ANATOMIA_LINK_PROMOTE_STREAK"];
    expect(promoteStreakThreshold()).toBe(3);
  });

  it("honours a valid override", () => {
    process.env["ANATOMIA_LINK_PROMOTE_STREAK"] = "5";
    expect(promoteStreakThreshold()).toBe(5);
  });

  it("throws on an invalid value (fail-fast, no silent fallback)", () => {
    process.env["ANATOMIA_LINK_PROMOTE_STREAK"] = "banana";
    expect(() => promoteStreakThreshold()).toThrow(/positive integer/);
    process.env["ANATOMIA_LINK_PROMOTE_STREAK"] = "0";
    expect(() => promoteStreakThreshold()).toThrow(/positive integer/);
  });
});

describe("local-state roundtrip (.anatomia/link-stability.json)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "anatomia-stability-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("missing file loads as the empty initial state", async () => {
    expect(await loadStability(root)).toEqual({});
  });

  it("save/load roundtrips and recordAnalysis accrues across runs", async () => {
    await recordAnalysis(root, [link("a.ts", "C1", 0.6)], "fp1");
    const state = await recordAnalysis(root, [link("a.ts", "C1", 0.6)], "fp2");
    expect(state["a.ts::C1"]).toMatchObject({ streak: 2 });
    expect(await loadStability(root)).toEqual(state);
    await saveStability(root, {});
    expect(await loadStability(root)).toEqual({});
  });
});
