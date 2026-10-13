/**
 * Free-text review notes on a domain, turned into Gate A review material.
 *
 * A person answering a domain review (Concordia's Discord review posts) writes
 * "this description is wrong" or "tie this to X" in plain words. Turning that
 * into proposal fields needs judgement, and the caller may hold no LLM, so this
 * layer does NOT translate the note: it keeps the words verbatim as human
 * evidence on a draft that a reviewer reads before approving anything. Nothing
 * here writes the domain definition; Gate A remains the only path that does.
 *
 * @spec domain organization / review notes
 */

import { createHash } from "node:crypto";
import type { SemanticProposalContext } from "./drift.js";

export type DomainReviewNoteKind = "description" | "assignment" | "other";

export interface DomainReviewNoteInput {
  domainId: string;
  /** The reviewer's own words; kept as written. */
  note: string;
  /** Where the note came from (e.g. a Concordia review answer id), for tracing. */
  reviewRef: string;
  kind?: DomainReviewNoteKind;
}

export interface DomainReviewNoteProposal extends SemanticProposalContext {
  proposalId: string;
  kind: "review-note";
  noteKind: DomainReviewNoteKind;
  affectedDomainIds: string[];
  note: string;
  reviewRef: string;
  evidence: { human: Array<{ field: "note"; value: string; reviewRef: string }> };
  unresolvedQuestions: string[];
  requiresGate: "gate-a";
}

/** Longest note accepted; longer text is refused rather than cut. */
export const REVIEW_NOTE_MAX_LENGTH = 4000;

const NOTE_KINDS: readonly DomainReviewNoteKind[] = ["description", "assignment", "other"];

const QUESTION: Record<DomainReviewNoteKind, string> = {
  description: "Should the domain's purpose or responsibilities be rewritten as this note says?",
  assignment: "Which code or spec should this note move into or out of the domain?",
  other: "What change to the domain definition, if any, does this note ask for?",
};

export type ReviewNoteValidation =
  | { ok: true; input: Required<DomainReviewNoteInput> }
  | { ok: false; reason: string };

/** Check one note against the known domains. Unknown domains are refused, not guessed. */
export function validateReviewNote(input: DomainReviewNoteInput, knownDomainIds: ReadonlySet<string>): ReviewNoteValidation {
  const domainId = typeof input.domainId === "string" ? input.domainId.trim() : "";
  const note = typeof input.note === "string" ? input.note.trim() : "";
  const reviewRef = typeof input.reviewRef === "string" ? input.reviewRef.trim() : "";
  const kind = input.kind ?? "other";
  if (!domainId) return { ok: false, reason: "domainId is required" };
  if (!knownDomainIds.has(domainId)) return { ok: false, reason: `unknown domain ${domainId}` };
  if (!note) return { ok: false, reason: "note is required" };
  if (note.length > REVIEW_NOTE_MAX_LENGTH) return { ok: false, reason: `note exceeds ${REVIEW_NOTE_MAX_LENGTH} characters` };
  if (!reviewRef) return { ok: false, reason: "reviewRef is required" };
  if (!NOTE_KINDS.includes(kind)) return { ok: false, reason: `kind must be one of ${NOTE_KINDS.join(", ")}` };
  return { ok: true, input: { domainId, note, reviewRef, kind } };
}

/**
 * Draft one Gate A review item per note. The id is stable for the same note on
 * the same analysis snapshot, so re-sending a note does not create a second draft.
 */
export function proposeFromReviewNotes(
  notes: ReadonlyArray<Required<DomainReviewNoteInput>>,
  context: SemanticProposalContext,
): DomainReviewNoteProposal[] {
  return notes
    .map((note) => {
      const digest = createHash("sha256")
        .update(JSON.stringify({ domainId: note.domainId, note: note.note, kind: note.kind, snapshot: context.analysisSnapshotId }), "utf8")
        .digest("hex")
        .slice(0, 20);
      return {
        proposalId: `proposal:domain-review-note/${digest}`,
        kind: "review-note" as const,
        noteKind: note.kind,
        affectedDomainIds: [note.domainId],
        note: note.note,
        reviewRef: note.reviewRef,
        evidence: { human: [{ field: "note" as const, value: note.note, reviewRef: note.reviewRef }] },
        unresolvedQuestions: [QUESTION[note.kind]],
        ...context,
        requiresGate: "gate-a" as const,
      };
    })
    .sort((left, right) => left.proposalId.localeCompare(right.proposalId));
}
