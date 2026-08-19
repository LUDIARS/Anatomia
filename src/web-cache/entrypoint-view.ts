/**
 * src/web-cache/entrypoint-view.ts — Prepare the [入口] tab's payload.
 *
 * The panel's invariant is that a view is prepared, never computed on open, so
 * the entry graph is derived here during the prepare run and served from disk
 * afterwards. Shaping is a pass-through: the derived graph already carries the
 * per-entry summary, the per-node colouring and the frontier, and re-deriving a
 * display-only variant would give the tab a second source of truth.
 *
 * SRP: view shaping only.
 */

import type { AnalysisContext } from "../core.js";
import { detectEntryPoints } from "../entrypoints/detect.js";
import { deriveEntryPointGraph } from "../entrypoints/derive.js";
import { buildColoring } from "../entrypoints/coloring.js";
import type { ScreenGraph } from "../screens/types.js";
import type { KnowledgeGraph } from "../knowledge/types.js";
import type { SceneInspection } from "../knowledge/scene/types.js";
import { describeCodeSymbol } from "../knowledge/code-symbol.js";
import type { EntryPointViewPayload } from "./types.js";

export interface BuildEntryPointViewOptions {
  projectId?: string;
  screens?: ScreenGraph;
  /** Approved domain edges, used for colouring only. */
  knowledgeState?: KnowledgeGraph;
  /** Prepared canonical scenes, used only to build stable-id deep links. */
  sceneInspection?: SceneInspection;
}

export async function buildEntryPointViewPayload(
  ctx: AnalysisContext,
  options: BuildEntryPointViewOptions = {},
): Promise<EntryPointViewPayload> {
  const manifest = await detectEntryPoints(ctx, options.screens ? { screens: options.screens } : {});
  const graph = await deriveEntryPointGraph({
    projectId: options.projectId ?? "web",
    sourceRevision: "web-cache",
    context: ctx,
    manifest,
    coloring: buildColoring(ctx, options.knowledgeState),
  });
  const scenesByCodeSymbol = new Map<string, string[]>();
  for (const scene of options.sceneInspection?.scenes ?? []) {
    if (scene.tombstone) continue;
    for (const symbolId of scene.reachedCodeSymbolIds) {
      const sceneIds = scenesByCodeSymbol.get(symbolId) ?? [];
      sceneIds.push(scene.id);
      scenesByCodeSymbol.set(symbolId, sceneIds);
    }
  }
  const functionsByAnchor = new Map(ctx.functions
    .filter((fn) => fn.id)
    .map((fn) => [String(fn.id), fn]));
  const sceneProjectId = options.sceneInspection?.manifest.projectId ?? options.projectId ?? "web";
  const sceneSourceRevision = options.sceneInspection?.manifest.sourceRevision ?? "web-cache";
  return {
    entries: graph.entries.map((entry) => {
      const fn = functionsByAnchor.get(String(entry.symbol.anchor));
      const symbolId = options.sceneInspection && fn
        ? describeCodeSymbol(sceneProjectId, ctx.repoPath, fn, sceneSourceRevision).symbolId
        : null;
      return {
        ...entry,
        sceneIds: symbolId ? [...new Set(scenesByCodeSymbol.get(symbolId) ?? [])].sort() : [],
      };
    }),
    nodes: graph.nodes,
    edges: graph.edges,
    unrooted: graph.unrooted,
    diagnostics: graph.diagnostics,
  };
}
