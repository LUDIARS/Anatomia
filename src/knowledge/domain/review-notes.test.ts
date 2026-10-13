import { describe, expect, it } from "vitest";
import { proposeFromReviewNotes, REVIEW_NOTE_MAX_LENGTH, validateReviewNote } from "./review-notes.js";

const CONTEXT = { sourceRevision: "sha256:abc", analysisSnapshotId: "analysis:abc", expectedHead: "tx:1" };
const KNOWN = new Set(["domain:combat", "domain:movement"]);

describe("validateReviewNote", () => {
  it("accepts a note on a known domain and keeps the words as written", () => {
    const checked = validateReviewNote({ domainId: " domain:combat ", note: "  ダメージ計算はここではなく武器側  ", reviewRef: "cc:answer/1" }, KNOWN);
    expect(checked).toEqual({ ok: true, input: {
      domainId: "domain:combat", note: "ダメージ計算はここではなく武器側", reviewRef: "cc:answer/1", kind: "other" } });
  });

  it("refuses an unknown domain instead of guessing one", () => {
    expect(validateReviewNote({ domainId: "domain:magic", note: "x", reviewRef: "r" }, KNOWN))
      .toEqual({ ok: false, reason: "unknown domain domain:magic" });
  });

  it("accepts a note without a domain as project-wide", () => {
    expect(validateReviewNote({ note: "全体の分け方が粗い", reviewRef: "cc:answer/9" }, KNOWN))
      .toEqual({ ok: true, input: { domainId: null, note: "全体の分け方が粗い", reviewRef: "cc:answer/9", kind: "other" } });
    expect(validateReviewNote({ domainId: "  ", note: "x", reviewRef: "r" }, KNOWN)).toMatchObject({ ok: true, input: { domainId: null } });
    expect(validateReviewNote({ domainId: 3 as never, note: "x", reviewRef: "r" }, KNOWN).ok).toBe(false);
  });

  it("refuses empty, oversized, untraceable or wrongly kinded notes", () => {
    expect(validateReviewNote({ domainId: "domain:combat", note: "   ", reviewRef: "r" }, KNOWN).ok).toBe(false);
    expect(validateReviewNote({ domainId: "domain:combat", note: "a".repeat(REVIEW_NOTE_MAX_LENGTH + 1), reviewRef: "r" }, KNOWN).ok).toBe(false);
    expect(validateReviewNote({ domainId: "domain:combat", note: "x", reviewRef: "" }, KNOWN).ok).toBe(false);
    expect(validateReviewNote({ domainId: "domain:combat", note: "x", reviewRef: "r", kind: "delete" as never }, KNOWN).ok).toBe(false);
  });
});

describe("proposeFromReviewNotes", () => {
  it("drafts one Gate A review item per note with the note as human evidence", () => {
    const [draft] = proposeFromReviewNotes([
      { domainId: "domain:combat", note: "説明が古い", reviewRef: "cc:answer/7", kind: "description" },
    ], CONTEXT);
    expect(draft).toMatchObject({
      kind: "review-note",
      noteKind: "description",
      affectedDomainIds: ["domain:combat"],
      note: "説明が古い",
      evidence: { human: [{ field: "note", value: "説明が古い", reviewRef: "cc:answer/7" }] },
      requiresGate: "gate-a",
      ...CONTEXT,
    });
    expect(draft!.unresolvedQuestions).toHaveLength(1);
    expect(draft!.proposalId).toMatch(/^proposal:domain-review-note\/[0-9a-f]{20}$/);
  });

  it("drafts a project-wide note with no domain and asks the reviewer which domain it concerns", () => {
    const [draft] = proposeFromReviewNotes([
      { domainId: null, note: "全体の分け方が粗い", reviewRef: "cc:answer/9", kind: "other" },
    ], CONTEXT);
    expect(draft!.affectedDomainIds).toEqual([]);
    expect(draft!.unresolvedQuestions).toHaveLength(2);
    expect(draft!.unresolvedQuestions[0]).toMatch(/Which domain/);
    expect(draft!.requiresGate).toBe("gate-a");
  });

  it("gives the same note on the same snapshot the same id, and a new snapshot a new id", () => {
    const note = { domainId: "domain:movement", note: "ジャンプも含める", reviewRef: "a", kind: "assignment" as const };
    const first = proposeFromReviewNotes([note], CONTEXT)[0]!.proposalId;
    const resent = proposeFromReviewNotes([{ ...note, reviewRef: "b" }], CONTEXT)[0]!.proposalId;
    const later = proposeFromReviewNotes([note], { ...CONTEXT, analysisSnapshotId: "analysis:def" })[0]!.proposalId;
    expect(resent).toBe(first);
    expect(later).not.toBe(first);
  });
});
