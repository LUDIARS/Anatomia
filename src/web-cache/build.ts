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
import { buildGraphOverview, buildGraphSlices } from "./graph-split.js";
import type { GraphSliceMap } from "./graph-split.js";
import { loadTaxonomyResolver } from "../domains/retune/load-taxonomy.js";
import { buildDomainViewPayload } from "../domains/domain-view-payload.js";
import { buildHotspots } from "../supply/hotspots.js";
import { buildSpecLinks } from "../domains/spec-links.js";
import { detectAccessPatterns } from "../patterns/detect.js";
import { buildSceneModules } from "./scene-modules.js";
import { buildSceneViewPayload } from "./scene-view.js";
import { buildEntryPointViewPayload } from "./entrypoint-view.js";
import { buildBusinessDomainViewPayload } from "./business-domain-view.js";
import { buildProgramDomainViewPayload } from "./program-domain-view.js";
import { buildSearchCorpus } from "./search-corpus.js";
import { buildProjectDomainMap } from "../map/sources.js";
import { fetchProjectCodes } from "../map/project-codes.js";
import type { SceneModel } from "../integral/scene.js";
import { emptySceneModel } from "../integral/scene.js";
import type { WebCacheBundle } from "./types.js";
import type { SceneInspection } from "../knowledge/scene/types.js";
import type { ScreenGraph } from "../screens/types.js";
import type { DomainCorrespondenceQuery } from "../knowledge/domain-correspondence/types.js";
import type { KnowledgeGraph } from "../knowledge/types.js";
import { buildReview } from "../review/build.js";

export interface BuildWebCacheOptions {
  /** Scene model (局面) for the scene/domain/module view. Default: empty. */
  sceneModel?: SceneModel;
  sceneInspection?: SceneInspection;
  screenGraph?: ScreenGraph;
  domainCorrespondence?: DomainCorrespondenceQuery;
  knowledgeState?: KnowledgeGraph;
  /** Project id, stamped into the prepared entry graph. */
  projectId?: string;
}

/** A prepare run's output: the view bundle + the per-group graph slices. */
export interface WebCacheBuild {
  bundle: WebCacheBundle;
  graphSlices: GraphSliceMap;
}

/** Build every web-display view from an analyzed context. */
export async function buildWebCacheBundle(
  ctx: AnalysisContext,
  options: BuildWebCacheOptions = {},
): Promise<WebCacheBuild> {
  const sceneModel = options.sceneModel ?? emptySceneModel();
  const sceneView = options.sceneInspection && options.screenGraph && options.domainCorrespondence
    ? buildSceneViewPayload(options.sceneInspection, options.screenGraph, options.domainCorrespondence)
    : { scenes: [] };
  const businessDomainView = options.sceneInspection && options.domainCorrespondence && options.knowledgeState
    ? buildBusinessDomainViewPayload(
      options.knowledgeState,
      options.domainCorrespondence,
      options.sceneInspection,
      ctx.specClauses,
      // Screen declaration files are the second UX-critical derivation source
      // (A-10); without a screen graph only direct scene entries count.
      (options.screenGraph?.screens ?? []).map((screen) => screen.file),
    )
    : { domains: [], relations: [], unlinkedProgramDomains: [] };

  // Module partition: computed once, reused by domain-view / scene-modules / search.
  const { evaluation, index } = await evaluateModulesFromGraph(ctx.graph, ctx.functions);

  // The feature-unit `group` per node comes from vis-data, and the Domain View
  // payload precomputes its per-domain graph from those nodes/edges — so build
  // vis-data first, then thread its nodes/edges into the domain-view builder.
  const moduleResolver = await loadTaxonomyResolver(ctx.repoPath);
  const graph = await buildVisData(ctx, undefined, { moduleResolver });
  const [domainView, hotspots, specLinks, sceneModules, searchCorpus, accessPatterns, review] =
    await Promise.all([
      buildDomainViewPayload(ctx, evaluation, graph.nodes, graph.edges),
      buildHotspots(ctx),
      buildSpecLinks(ctx),
      buildSceneModules(ctx, evaluation, index, sceneModel),
      buildSearchCorpus(ctx, evaluation, index),
      // Access patterns were previously detected on every Domain View open via a
      // live route that re-analyzed the repo + re-read every source file. Prepare
      // them once here so the panel serves them from disk with no re-analysis.
      detectAccessPatterns(ctx),
      buildReview(ctx),
    ]);
  const entrypointView = await buildEntryPointViewPayload(ctx, {
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.screenGraph ? { screens: options.screenGraph } : {}),
    ...(options.knowledgeState ? { knowledgeState: options.knowledgeState } : {}),
    ...(options.sceneInspection ? { sceneInspection: options.sceneInspection } : {}),
  });
  const programDomainView = await buildProgramDomainViewPayload(ctx, evaluation, graph, options.domainCorrespondence ?? { programDomains: [], businessDomains: [], specClauses: [] }, review, options.knowledgeState);

  const domains = (ctx.domains ?? []).map((d) => ({
    domain: d.domain,
    implementorCount: d.implementors.length,
    conforms: d.conforms,
    violationCount: d.violations.length,
  }));

  // The full VisData is a build intermediate only: at real-repo scale it is
  // unservable as one payload (measured 353MB), so the persisted graph view is
  // the small group-granularity OVERVIEW and the panel zooms into per-group
  // slices fetched lazily (graph-split.ts).
  // The domain map is derived from committed declarations, not from the graph,
  // but it is prepared HERE so a project's records are on disk with the rest of
  // its views and the cross-project search can start from the artifact instead
  // of re-reading every repo (design §12.3).
  const roster = await fetchProjectCodes();
  const domainMap = await buildProjectDomainMap(
    { id: options.projectId ?? "repo", rootPath: ctx.repoPath },
    { roster: roster.codes, rosterError: roster.error },
  );

  const overview = buildGraphOverview(graph);
  const graphSlices = buildGraphSlices(graph);

  return {
    bundle: {
      graph: overview,
      "domain-view": domainView,
      "business-domain-view": businessDomainView,
      "program-domain-view": programDomainView,
      "scene-view": sceneView,
      "entrypoint-view": entrypointView,
      "access-patterns": accessPatterns,
      hotspots,
      "spec-links": specLinks,
      domains,
      "scene-modules": sceneModules,
      "search-corpus": searchCorpus,
      "domain-map": domainMap,
    },
    graphSlices,
  };
}
