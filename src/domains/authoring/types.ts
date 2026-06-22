/**
 * src/domains/authoring/types.ts — Editable, human-adjustable domain defs.
 *
 * The design's challenge 1 (domain analysis is weak): seed a COARSE domain
 * definition from the spec, then let a human adjust it. Domains differ by author
 * (they may or may not include mechanics) so there is NO fixed rule for their
 * shape — these types only carry provenance + a lock list so reconstruction
 * never clobbers a human's edits. A scene state is NOT part of a domain, though
 * a domain may coincide with one.
 *
 * An EditableDomainDef is a superset of DomainDef: the extra fields are ignored
 * by the detection pipeline (which validates only name/description/presetRules/
 * templateRules), so an editable def stored in a project's ontology dir is loaded
 * and detected with no pipeline changes.
 *
 * SRP: type definitions only.
 */

import type { DomainDef } from "../ontology.js";

/** DomainDef fields a human may lock against reconstruction. */
export type LockableField = "description" | "presetRules" | "templateRules" | "cardTemplate";

export const LOCKABLE_FIELDS: LockableField[] = [
  "description",
  "presetRules",
  "templateRules",
  "cardTemplate",
];

/** How a domain def came to exist. */
export type DomainSource = "spec-draft" | "manual" | "reconstructed";

/** A persisted, human-adjustable domain def (DomainDef + provenance). */
export interface EditableDomainDef extends DomainDef {
  /** Provenance: spec-seeded draft, hand-written, or reconstructed from a re-draft. */
  source: DomainSource;
  /** Fields the human locked; reconstruction preserves these. "*" locks all. */
  lockedFields?: (LockableField | "*")[];
  /** Mechanics this domain involves (may be empty — domains need not include mechanics). */
  mechanics?: string[];
  /** Spec clause headings/ids this domain ties to (informational; spec linkage is authoritative). */
  specRefs?: string[];
  /** Why the synthesiser proposed it (kept for human review). */
  rationale?: string;
  /** ISO timestamp of the last write (informational). */
  updatedAt?: string;
}

/**
 * A coarse, machine-proposed domain BEFORE human adjustment. Intentionally light
 * ("雑に作る"): membership is expressed as path/name patterns; the human refines.
 */
export interface DomainDraft {
  name: string;
  description: string;
  /** Suggested member file-path regexes (→ NodeFilter.pathPattern). */
  pathPatterns: string[];
  /** Suggested member function-name regexes (→ NodeFilter.namePattern). */
  namePatterns: string[];
  /** Candidate spec clause headings/ids this domain ties to. */
  specRefs: string[];
  /** Optional mechanics this domain involves. */
  mechanics: string[];
  /** Evidence for why the synthesiser proposed it. */
  rationale: string;
}

/** Result of reconciling fresh drafts against the existing editable defs. */
export interface ReconcileResult {
  merged: EditableDomainDef[];
  /** Names of newly added domains. */
  added: string[];
  /** Names of domains updated from a draft (unlocked fields changed). */
  updated: string[];
  /** Names preserved unchanged because they were locked / manual. */
  preserved: string[];
}
