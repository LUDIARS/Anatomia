/**
 * src/supply/plan/exemplar.ts — Step 5: the implementation to imitate.
 *
 * Reuses the landing layer's precedent selection (supply/landing.ts
 * `pickPrecedent` + supply/detectors.ts `contextSiblingLookup`) rather than
 * ranking siblings a second way: `where` and `plan` must not disagree about
 * which existing function is a domain's exemplar.
 *
 * SRP: sibling lookup → one exemplar per domain.
 *
 * @spec パイプライン（`src/supply/plan/`）
 */

import { contextLayerRules, contextSiblingLookup } from "../detectors.js";
import { pickPrecedent } from "../landing.js";
import { repoRelative, type PlanRepo } from "./collect.js";
import type { PlanExemplar } from "./types.js";

/** The exemplar for `domain`, or null when the domain has no implementor yet. */
export async function findExemplar(
  repo: PlanRepo,
  domain: string,
): Promise<PlanExemplar | null> {
  const layer = contextLayerRules(repo.ctx).layerFor(domain);
  const siblings = await contextSiblingLookup(repo.ctx)(domain, layer);
  const precedent = pickPrecedent(siblings);
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

/** The layer a domain mostly lives in, for the plan item's `layer` field. */
export function domainLayer(repo: PlanRepo, domain: string): string | null {
  return contextLayerRules(repo.ctx).layerFor(domain);
}
