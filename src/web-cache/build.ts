/**
 * src/web-cache/build.ts — Build the full web-display bundle for a project.
 *
 * One prepare run = analyze once, then build every view from that single context.
 * The module partition (evaluateModulesFromGraph) is computed ONCE here and
 * threaded into the domain-view / scene-modules / search-corpus builders so the
 * expensive edge walk is not repeated per view.
 *
 * SRP: orchestration only. Each view's shaping lives in its own module.
 */

import type { AnalysisContext } from "../core.js";
import { evaluateModulesFromGraph } from "../modules/evaluate.js";
import { buildVisData } from "../adapters/web/vis-data.js";
import { loadTaxonomyResolver } from "../domains/retune/load-taxonomy.js";
import { buildDomainViewPayload } from "../domains/domain-view-payload.js";
import { buildHotspots } from "../supply/hotspots.js";
import { buildSpecLinks } from "../domains/spec-links.js";
import { buildSceneModules } from "./scene-modules.js";
import { buildSearchCorpus } from "./search-corpus.js";
import type { SceneModel } from "../integral/scene.js";
import { emptySceneModel } from "../integral/scene.js";
import type { WebCacheBundle } from "./types.js";

export interface BuildWebCacheOptions {
  /** Scene model (局面) for the scene/domain/module view. Default: empty. */
  sceneModel?: SceneModel;
}

/** Build every web-display view from an analyzed context. */
export async function buildWebCacheBundle(
  ctx: AnalysisContext,
  options: BuildWebCacheOptions = {},
): Promise<WebCacheBundle> {
  const sceneModel = options.sceneModel ?? emptySceneModel();

  // Module partition: computed once, reused by domain-view / scene-modules / search.
  const { evaluation, index } = await evaluateModulesFromGraph(ctx.graph, ctx.functions);

  const moduleResolver = await loadTaxonomyResolver(ctx.repoPath);
  const [graph, domainView, hotspots, specLinks, sceneModules, searchCorpus] = await Promise.all([
    buildVisData(ctx, undefined, { moduleResolver }),
    buildDomainViewPayload(ctx, evaluation),
    buildHotspots(ctx),
    buildSpecLinks(ctx),
    buildSceneModules(ctx, evaluation, index, sceneModel),
    buildSearchCorpus(ctx, evaluation, index),
  ]);

  const domains = (ctx.domains ?? []).map((d) => ({
    domain: d.domain,
    implementorCount: d.implementors.length,
    conforms: d.conforms,
    violationCount: d.violations.length,
  }));

  return {
    graph,
    "domain-view": domainView,
    hotspots,
    "spec-links": specLinks,
    domains,
    "scene-modules": sceneModules,
    "search-corpus": searchCorpus,
  };
}
