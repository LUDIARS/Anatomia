/**
 * review → retune 還流 — the deterministic domain-review findings must surface
 * as (a) evidence lines in the step-5/6 prompts and (b) human-review notes.
 * Pure string/logic tests, hermetic.
 */

import { describe, it, expect } from "vitest";
import { reviewEvidenceSection, step5Prompt, step6Prompt } from "./prompts.js";
import { reviewFeedbackNotes } from "./pipeline.js";
import type { DomainPlan, DomainReviewSummary } from "./types.js";

const REVIEW: DomainReviewSummary = {
  domains: [
    { domain: "big", internalEdges: 2, boundaryEdges: 8, cohesion: 0.2 },
    { domain: "other", internalEdges: 9, boundaryEdges: 1, cohesion: 0.9 },
    { domain: "edgeless", internalEdges: 0, boundaryEdges: 0, cohesion: null },
  ],
  boundaryDrift: [
    {
      name: "fnDrift",
      file: "src/m1/a.ts",
      line: 3,
      domain: "big",
      suggested: "other",
      votes: [
        { domain: "other", count: 3 },
        { domain: "big", count: 1 },
      ],
    },
  ],
  overlap: [{ name: "fnShared", file: "src/m2/b.ts", line: 5, domains: ["big", "other"] }],
};

describe("reviewEvidenceSection", () => {
  it("renders cohesion, drift and overlap lines for the named domains", () => {
    const lines = reviewEvidenceSection(REVIEW, ["big"]).join("\n");
    expect(lines).toContain("Domain review evidence");
    expect(lines).toContain('domain "big": cohesion 0.20 (internal 2 / boundary 8 calls edges)');
    expect(lines).toContain("boundary drift: fnDrift (src/m1/a.ts:3) assigned=big neighbours-suggest=other (votes other:3, big:1)");
    expect(lines).toContain("overlap: fnShared (src/m2/b.ts:5) claimed by [big, other]");
    // "other" is not asked for → its cohesion stat is filtered out.
    expect(lines).not.toContain('domain "other"');
  });

  it("renders n/a for edge-free domains and is empty when nothing matches", () => {
    expect(reviewEvidenceSection(REVIEW, ["edgeless"]).join("\n")).toContain("cohesion n/a");
    expect(reviewEvidenceSection(REVIEW, ["unrelated"])).toEqual([]);
    expect(reviewEvidenceSection(undefined, ["big"])).toEqual([]);
  });
});

describe("step prompts with reviewFindings", () => {
  const bigDomain: DomainPlan = {
    name: "big",
    description: "b",
    modules: [{ name: "m1", description: "", paths: ["src/m1/"] }],
  };

  it("step5Prompt embeds the evidence for the split target domain", () => {
    const p = step5Prompt({ domain: bigDomain, review: REVIEW });
    expect(p).toContain("Domain review evidence");
    expect(p).toContain("cohesion 0.20");
    expect(p).toContain("boundary drift: fnDrift");
    expect(p).toContain("overlap: fnShared");
  });

  it("step5Prompt without review has no evidence section", () => {
    expect(step5Prompt({ domain: bigDomain })).not.toContain("Domain review evidence");
  });

  it("step6Prompt scopes evidence to the small modules' domains", () => {
    const small = [{ name: "t1", domain: "other", nodeCount: 1, description: "" }];
    const p = step6Prompt({ smallModules: small, review: REVIEW });
    expect(p).toContain('domain "other": cohesion 0.90');
    // drift/overlap involve "other" too, so they stay visible as evidence.
    expect(p).toContain("boundary drift: fnDrift");
    expect(p).not.toContain('domain "big"');
  });
});

describe("reviewFeedbackNotes", () => {
  it("notes low-cohesion domains and boundary drift for human review", () => {
    const notes = reviewFeedbackNotes(REVIEW).join("\n");
    expect(notes).toContain("低凝集ドメイン 1 件");
    expect(notes).toContain("big (cohesion 0.20, internal 2 / boundary 8)");
    expect(notes).not.toContain("edgeless"); // null cohesion is not "low"
    expect(notes).toContain("境界ズレ疑い 1 件");
    expect(notes).toContain("fnDrift (src/m1/a.ts:3) big → other");
  });

  it("is empty when the review is clean", () => {
    const clean: DomainReviewSummary = {
      domains: [{ domain: "ok", internalEdges: 5, boundaryEdges: 1, cohesion: 5 / 6 }],
      boundaryDrift: [],
      overlap: [],
    };
    expect(reviewFeedbackNotes(clean)).toEqual([]);
  });
});
