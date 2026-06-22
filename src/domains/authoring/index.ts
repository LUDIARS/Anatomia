/**
 * src/domains/authoring/index.ts — Domain-authoring public surface.
 *
 * Seed coarse domain drafts from the spec (draft.ts), let a human adjust them on
 * disk (store.ts), and reconstruct without clobbering edits (reconcile.ts). The
 * saved editable defs live in the project's ontology dir, so the existing
 * detection pipeline consumes them with no further wiring.
 */

export type {
  EditableDomainDef,
  DomainDraft,
  DomainSource,
  LockableField,
  ReconcileResult,
} from "./types.js";
export { LOCKABLE_FIELDS } from "./types.js";
export {
  domainsDir,
  domainFileName,
  draftToEditableDef,
  loadEditableDomains,
  saveEditableDomain,
  saveEditableDomains,
  toDomainDef,
} from "./store.js";
export {
  synthesizeDomainDrafts,
  seedDraftsFromStructure,
  assembleDraftPrompt,
  parseDrafts,
  buildModuleMap,
  DRAFT_PROMPT_VERSION,
  type DraftInputs,
  type DraftCache,
} from "./draft.js";
export { reconcileDrafts } from "./reconcile.js";
