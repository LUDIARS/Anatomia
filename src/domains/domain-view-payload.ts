/**
 * src/domains/domain-view-payload.ts — Assemble the Domain View payload.
 *
 * The Domain View payload = per-domain focus (views + JP spec descriptions) plus
 * the per-domain 機能(module) breakdown and the whole-partition module evaluation.
 * Extracted from the web route so the same payload feeds both the live route and
 * the prepared web cache; the optional `evaluation` lets a caller that already
 * computed the module partition (web-cache/build.ts) avoid recomputing it.
 *
 * SRP: view + module assembly. No HTTP, no caching.
 */

import { buildDomainView } from "./view.js";
import { buildDomainModules } from "./view-modules.js";
import type { DomainView } from "./view.js";
import type { DomainModuleRef } from "./view-modules.js";
import { evaluateModulesFromGraph } from "../modules/evaluate.js";
import type { ModuleEvaluation, MisfitFunction } from "../modules/types.js";
import type { AnalysisContext } from "../core.js";

/** Number of misfit rows surfaced to the panel (full set is large on real repos). */
export const DOMAIN_VIEW_MISFIT_CAP = 50;

/** The Domain View payload returned by the route + persisted to the web cache. */
export interface DomainViewPayload {
  views: DomainView[];
  modulesByDomain: Record<string, DomainModuleRef[]>;
  modularity: number;
  granularity: ModuleEvaluation["granularity"];
  misfits: MisfitFunction[];
}

/**
 * Build the Domain View payload for a context. Pass a precomputed `evaluation`
 * to reuse a module partition computed elsewhere.
 */
export async function buildDomainViewPayload(
  ctx: AnalysisContext,
  evaluation?: ModuleEvaluation,
): Promise<DomainViewPayload> {
  // Spec links are file-anchored; domain implementors are function-anchored.
  // Pass the implementor→file map so file-anchored links reach their domain.
  const anchorToFile = new Map<string, string>();
  for (const fn of ctx.functions) {
    if (fn.id) anchorToFile.set(fn.id, fn.sourceRange.filePath);
  }
  const views = buildDomainView(
    ctx.domains ?? [],
    ctx.links ?? [],
    ctx.specClauses ?? [],
    anchorToFile,
  );
  const evalResult =
    evaluation ?? (await evaluateModulesFromGraph(ctx.graph, ctx.functions)).evaluation;
  const modulesByDomain = buildDomainModules(ctx.domains ?? [], evalResult);
  return {
    views,
    modulesByDomain,
    modularity: evalResult.modularity,
    granularity: evalResult.granularity,
    misfits: evalResult.misfits.slice(0, DOMAIN_VIEW_MISFIT_CAP),
  };
}
