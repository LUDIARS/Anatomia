/**
 * src/domains/domain-view-payload.ts — Assemble the Domain View payload.
 *
 * The Domain View payload = per-domain focus (views + JP spec descriptions), the
 * per-domain 機能(module) breakdown, the whole-partition module evaluation, AND
 * the per-domain precomputed feature-unit graph (view-graph.ts). Shipping the
 * unit graph here means the panel no longer downloads the full function-level
 * vis-data and folds it per click — it renders straight from `graphByDomain` and
 * only runs the cheap interactive fold (public/domain-view-logic.js).
 *
 * The graph needs vis-data nodes/edges (the resolved feature-unit `group` per
 * node). Those are passed IN by the caller (web-cache/build.ts or the route) so
 * this domains-layer module never imports the adapters-layer vis-data builder.
 * The optional `evaluation` lets a caller that already computed the module
 * partition avoid recomputing it.
 *
 * SRP: view + module + unit-graph assembly. No HTTP, no caching, no vis build.
 */

import { buildDomainView } from "./view.js";
import { buildDomainModules } from "./view-modules.js";
import { aggregateDomainUnits } from "./view-graph.js";
import type { DomainView } from "./view.js";
import type { DomainModuleRef } from "./view-modules.js";
import type { DomainUnitGraph, UnitGraphNode, UnitGraphEdge } from "./view-graph.js";
import { evaluateModulesFromGraph } from "../modules/evaluate.js";
import type { ModuleEvaluation, MisfitFunction } from "../modules/types.js";
import type { AnalysisContext } from "../core.js";

/** Number of misfit rows surfaced to the panel (full set is large on real repos). */
export const DOMAIN_VIEW_MISFIT_CAP = 50;

/**
 * Max feature units rendered per domain. MUST match the panel's `DV_MAX_UNITS`
 * (index.html) so the precomputed truncation and the panel's "top N of M" note
 * agree. Changing one without the other desyncs the count badge.
 */
export const DOMAIN_VIEW_MAX_UNITS = 60;

/** The Domain View payload returned by the route + persisted to the web cache. */
export interface DomainViewPayload {
  views: DomainView[];
  modulesByDomain: Record<string, DomainModuleRef[]>;
  modularity: number;
  granularity: ModuleEvaluation["granularity"];
  misfits: MisfitFunction[];
  /** Precomputed feature-unit graph per domain (panel folds it client-side). */
  graphByDomain: Record<string, DomainUnitGraph>;
}

/**
 * Build the Domain View payload for a context. `graphNodes`/`graphEdges` are the
 * vis-data nodes/edges (their resolved `group` defines the feature units); pass
 * a precomputed `evaluation` to reuse a module partition computed elsewhere.
 */
export async function buildDomainViewPayload(
  ctx: AnalysisContext,
  evaluation: ModuleEvaluation | undefined,
  graphNodes: UnitGraphNode[],
  graphEdges: UnitGraphEdge[],
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

  // Precompute each domain's feature-unit graph from the shared vis-data, so the
  // panel renders without re-downloading the full graph or aggregating per click.
  const graphByDomain: Record<string, DomainUnitGraph> = {};
  for (const v of views) {
    graphByDomain[v.domain] = aggregateDomainUnits(v.implementors, graphNodes, graphEdges, {
      maxUnits: DOMAIN_VIEW_MAX_UNITS,
    });
  }

  return {
    views,
    modulesByDomain,
    modularity: evalResult.modularity,
    granularity: evalResult.granularity,
    misfits: evalResult.misfits.slice(0, DOMAIN_VIEW_MISFIT_CAP),
    graphByDomain,
  };
}
