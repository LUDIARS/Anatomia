/**
 * src/supply/plan/exemplar.ts — Step 5: the implementation to imitate.
 *
 * The siblings come from the landing layer (supply/detectors.ts
 * `contextSiblingLookup`), so `where` and `plan` see the same candidate set. The
 * PICK, however, is the plan's own: `where` answers "where does this land", and
 * ranking by layer then reference count is right for that. A plan answers "what
 * should this code look like", and reference count alone got that wrong —
 * measured on the first plan PR, Figmentum's exemplar came out as
 * `demo/graph/snippet_cache.h:size`, an accessor that is heavily referenced
 * exactly because it says nothing.
 *
 * The plan therefore prefers, in order:
 *   1. a non-accessor (public-api.ts) — an accessor is never a design to copy
 *   2. a sibling whose name shares a token with the TASK — the closest thing to
 *      "an implementation of this kind of thing already exists"
 *   3. a sibling in the domain's own majority layer — not a vendored copy
 *   4. reference count, then `pickPrecedent`'s deterministic tie-break
 *
 * SRP: sibling lookup → one exemplar per domain.
 *
 * @spec パイプライン（`src/supply/plan/`）
 */

import { contextLayerRules, contextSiblingLookup } from "../detectors.js";
import { pickPrecedent, type Sibling } from "../landing.js";
import { tokenizeRelevanceText } from "../relevance.js";
import { repoRelative, type PlanRepo } from "./collect.js";
import { isAccessorName } from "./public-api.js";
import type { PlanExemplar } from "./types.js";

/** Extra ranking context; absent fields simply do not contribute. */
export interface ExemplarOptions {
  /** The task text, so a sibling that names what the task asks for wins. */
  task?: string;
}

/** The exemplar for `domain`, or null when the domain has no implementor yet. */
export async function findExemplar(
  repo: PlanRepo,
  domain: string,
  options: ExemplarOptions = {},
): Promise<PlanExemplar | null> {
  const layer = contextLayerRules(repo.ctx).layerFor(domain);
  const siblings = await contextSiblingLookup(repo.ctx)(domain, layer);
  const precedent = pickExemplarSibling(siblings, layer, options.task ?? "");
  if (!precedent) return null;
  const fn = repo.ctx.functions.find((f) => f.id === precedent.anchor);
  return {
    anchor: precedent.anchor,
    name: precedent.name,
    path: fn ? repoRelative(repo.repoPath, fn.sourceRange.filePath) : "",
    layer: precedent.layer,
    references: precedent.references ?? 0,
  };
}

/**
 * Choose the sibling a plan should hold up as the exemplar.
 *
 * Each preference NARROWS the candidate set and is skipped when it would empty
 * it: a domain made entirely of accessors still gets an exemplar (the best of
 * what exists) rather than none, and the final pick always goes through
 * `pickPrecedent` so the tie-break stays the one `where` uses.
 */
export function pickExemplarSibling(
  siblings: Sibling[],
  domainLayer: string | null,
  task: string,
): Sibling | undefined {
  if (siblings.length === 0) return undefined;
  let candidates = narrow(siblings, (sibling) => !isAccessorName(sibling.name));

  const taskTokens = new Set(tokenizeRelevanceText(task).filter((token) => token.length >= 3));
  if (taskTokens.size > 0) {
    // Keep the siblings that share the MOST task vocabulary, not merely one
    // token: `MakeSnippetCache` and `EvictSnippet` both contain "snippet", and
    // only the second is about the eviction the task asked for.
    const overlap = new Map(candidates.map((sibling) => [sibling, taskOverlap(sibling, taskTokens)]));
    const best = Math.max(...overlap.values());
    if (best > 0) candidates = candidates.filter((sibling) => overlap.get(sibling) === best);
  }

  if (domainLayer !== null) {
    candidates = narrow(candidates, (sibling) => sibling.layer === domainLayer);
  }

  return pickPrecedent(candidates);
}

/** How many distinct task tokens a sibling's name carries. */
function taskOverlap(sibling: Sibling, taskTokens: Set<string>): number {
  return new Set(tokenizeRelevanceText(sibling.name).filter((token) => taskTokens.has(token))).size;
}

/** Apply a preference, unless nothing survives it. */
function narrow(siblings: Sibling[], keep: (sibling: Sibling) => boolean): Sibling[] {
  const kept = siblings.filter(keep);
  return kept.length > 0 ? kept : siblings;
}

/** The layer a domain mostly lives in, for the plan item's `layer` field. */
export function domainLayer(repo: PlanRepo, domain: string): string | null {
  return contextLayerRules(repo.ctx).layerFor(domain);
}
