/**
 * src/domains/authoring/reconcile.ts — Merge fresh drafts with existing edits.
 *
 * Reconstruction is allowed ("ドメインを再構成することはあってもよい") but it must
 * NOT destroy a human's adjustments. This module merges a freshly synthesised
 * draft set against the editable defs already on disk:
 *   - a draft with no existing def         → added as a new spec-draft def;
 *   - a draft whose def is locked / manual  → preserved untouched;
 *   - otherwise                             → unlocked fields refreshed from the
 *                                             draft, locked fields kept, marked
 *                                             "reconstructed";
 *   - an existing def with no matching draft → carried through unchanged.
 *
 * SRP: merge policy only. Draft synthesis is draft.ts; persistence is store.ts.
 */

import type { DomainDraft, EditableDomainDef, LockableField, ReconcileResult } from "./types.js";
import { LOCKABLE_FIELDS } from "./types.js";
import { draftToEditableDef } from "./store.js";

/** The effective set of locked fields for a def ("*" expands to all lockable). */
function lockedSet(def: EditableDomainDef): Set<LockableField> {
  const locks = def.lockedFields ?? (def.source === "manual" ? ["*"] : []);
  if (locks.includes("*")) return new Set(LOCKABLE_FIELDS);
  return new Set(locks.filter((f): f is LockableField => f !== "*"));
}

/**
 * Merge one draft into one existing def, honouring locks. Returns the merged def
 * and whether anything actually changed.
 */
function mergeOne(
  existing: EditableDomainDef,
  draft: EditableDomainDef,
  force: boolean,
): { def: EditableDomainDef; changed: boolean } {
  const locked = force ? new Set<LockableField>() : lockedSet(existing);
  const merged: EditableDomainDef = { ...existing };
  let changed = false;
  for (const field of LOCKABLE_FIELDS) {
    if (locked.has(field)) continue;
    const next = draft[field];
    if (JSON.stringify(next) !== JSON.stringify(existing[field])) changed = true;
    (merged as unknown as Record<string, unknown>)[field] = next;
  }
  // Refresh authoring metadata from the draft (not lockable).
  merged.mechanics = draft.mechanics;
  merged.specRefs = draft.specRefs;
  merged.rationale = draft.rationale;
  if (changed) merged.source = "reconstructed";
  return { def: merged, changed };
}

/**
 * Reconcile a fresh draft set against the existing editable defs.
 *
 * @param force  Overwrite even locked / manual defs (a human "redo from scratch").
 */
export function reconcileDrafts(
  existing: EditableDomainDef[],
  drafts: DomainDraft[],
  opts: { force?: boolean } = {},
): ReconcileResult {
  const force = opts.force ?? false;
  const byName = new Map(existing.map((d) => [d.name, d]));
  const added: string[] = [];
  const updated: string[] = [];
  const preserved: string[] = [];
  const handled = new Set<string>();

  for (const draft of drafts) {
    handled.add(draft.name);
    const draftDef = draftToEditableDef(draft);
    const prior = byName.get(draft.name);
    if (!prior) {
      byName.set(draft.name, draftDef);
      added.push(draft.name);
      continue;
    }
    const locked = force ? new Set<LockableField>() : lockedSet(prior);
    if (!force && locked.size === LOCKABLE_FIELDS.length) {
      preserved.push(draft.name);
      continue;
    }
    const { def, changed } = mergeOne(prior, draftDef, force);
    byName.set(draft.name, def);
    if (changed) updated.push(draft.name);
    else preserved.push(draft.name);
  }

  // Existing defs without a matching draft are carried through unchanged.
  const merged = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { merged, added, updated, preserved };
}
