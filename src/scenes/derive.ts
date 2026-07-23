/**
 * src/scenes/derive.ts — Static scene derivation by call-graph reachability.
 *
 * The shallow projection (from-screens.ts) attributes a scene only to the
 * domains of its OWN file. This module walks the code transitions instead:
 * starting from every function declared in a screen's file, it follows `calls`
 * edges through the graph and attributes the scene to every domain reached in
 * that closure. The result is the "what does this scene actually activate"
 * answer a trace would give, computed statically — so projects with no
 * recorded trace still get a meaningful scene layer.
 *
 * Scene ids come from assignSceneIds (from-screens.ts) so a derived scene and
 * its shallow projection are the same entity. Navigation targets become scene
 * transitions when they resolve to a detected screen.
 *
 * Everything here is deterministic (sorted outputs, no LLM, no wall clock), so
 * a DerivedSceneGraph can be persisted as a fingerprint-keyed artifact — the
 * scene cache that downstream analyses (Omnipotens 等) read without paying for
 * re-analysis.
 *
 * SRP: derivation only. No filesystem, no HTTP, no persistence (the artifact
 * store lives in project/cache.ts; adapters wire the two together).
 */

import { relative } from "node:path";
import type { AnalysisContext } from "../core.js";
import type { AnchorId } from "../types.js";
import type { ScreenGraph, ScreenKind, ScreenNode, ScreenStack } from "../screens/index.js";
import type { SceneRef } from "../integral/scene.js";
import { assignSceneIds } from "./from-screens.js";

/** One derived scene: a SceneRef enriched with provenance + reachability data. */
export interface DerivedScene extends SceneRef {
  /** Repo-relative, forward-slashed declaring file ("" for scene-only screens). */
  file: string;
  kind: ScreenKind;
  stack: ScreenStack;
  route?: string;
  /** Domains of the screen's own file (the shallow attribution), sorted. */
  directDomains: string[];
  /** Functions declared in the screen's file (the closure's entry set). */
  entryFunctions: number;
  /** Functions reachable from the entry set via `calls` edges (incl. entries). */
  reachedFunctions: number;
  /** Scene ids this screen navigates to (resolved targets only), sorted. */
  transitions: string[];
}

/** The whole derived scene layer for one analysis — the scene-cache payload. */
export interface DerivedSceneGraph {
  version: 1;
  scenes: DerivedScene[];
  summary: {
    total: number;
    /** Scenes whose file contributed at least one entry function. */
    withEntries: number;
    /** Total resolved scene→scene transitions. */
    transitions: number;
    /** Distinct domains activated by at least one scene. */
    domainsCovered: number;
  };
}

export interface DeriveOptions {
  /**
   * Reachability depth limit over `calls` edges. Default: unlimited (the whole
   * closure). A cap trades attribution completeness for speed on huge graphs.
   */
  maxDepth?: number;
}

/**
 * Derive the scene layer from a screen graph + analysis context by walking the
 * call graph from each screen's functions. Deterministic: output order and all
 * nested lists are sorted.
 */
export async function deriveScenes(
  ctx: AnalysisContext,
  screenGraph: ScreenGraph,
  options: DeriveOptions = {},
): Promise<DerivedSceneGraph> {
  const domainsByAnchor = buildDomainIndex(ctx);
  const anchorsByFile = buildFileIndex(ctx);
  const ids = assignSceneIds(screenGraph);
  const idByName = new Map<string, string>();
  for (const [screen, id] of ids) {
    // First declaration wins on duplicate names — same rule the detector uses
    // when resolving navigation targets by name.
    if (!idByName.has(screen.name)) idByName.set(screen.name, id);
  }

  const scenes: DerivedScene[] = [];
  for (const screen of screenGraph.screens) {
    const entries = screen.file ? (anchorsByFile.get(screen.file) ?? []) : [];
    const reached = await reachClosure(ctx, entries, options.maxDepth);
    const domains = new Set<string>(screen.domains);
    for (const anchor of reached) {
      for (const d of domainsByAnchor.get(anchor) ?? []) domains.add(d);
    }
    const transitions = [
      ...new Set(
        screen.navigatesTo
          .map((target) => idByName.get(target))
          .filter((id): id is string => id !== undefined),
      ),
    ].sort();
    scenes.push({
      id: ids.get(screen)!,
      label: screen.route ? `${screen.name} (${screen.route})` : screen.name,
      domains: [...domains].sort(),
      file: screen.file,
      kind: screen.kind,
      stack: screen.stack,
      ...(screen.route !== undefined ? { route: screen.route } : {}),
      directDomains: [...new Set(screen.domains)].sort(),
      entryFunctions: entries.length,
      reachedFunctions: reached.size,
      transitions,
    });
  }
  scenes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const domainsCovered = new Set<string>();
  for (const s of scenes) for (const d of s.domains) domainsCovered.add(d);
  return {
    version: 1,
    scenes,
    summary: {
      total: scenes.length,
      withEntries: scenes.filter((s) => s.entryFunctions > 0).length,
      transitions: scenes.reduce((n, s) => n + s.transitions.length, 0),
      domainsCovered: domainsCovered.size,
    },
  };
}

// ---------------------------------------------------------------------------
// Indices + traversal
// ---------------------------------------------------------------------------

/** AnchorId → domains that list it as an implementor. */
function buildDomainIndex(ctx: AnalysisContext): Map<AnchorId, string[]> {
  const index = new Map<AnchorId, string[]>();
  for (const result of ctx.domains ?? []) {
    for (const anchor of result.implementors) {
      const list = index.get(anchor) ?? [];
      list.push(result.domain);
      index.set(anchor, list);
    }
  }
  return index;
}

/** Repo-relative forward-slashed file path → anchors of its functions. */
function buildFileIndex(ctx: AnalysisContext): Map<string, AnchorId[]> {
  const index = new Map<string, AnchorId[]>();
  for (const file of ctx.files) {
    const rel = relative(ctx.repoPath, file.path).replace(/\\/g, "/");
    const anchors = file.functions
      .map((fn) => fn.id)
      .filter((id): id is AnchorId => id !== null);
    if (anchors.length > 0) index.set(rel, anchors);
  }
  return index;
}

/**
 * BFS over outgoing `calls` edges from the whole entry set at once (one
 * traversal per scene, not per function). Returns entries ∪ reachable.
 */
async function reachClosure(
  ctx: AnalysisContext,
  entries: AnchorId[],
  maxDepth?: number,
): Promise<Set<AnchorId>> {
  const seen = new Set<AnchorId>(entries);
  let frontier = [...entries];
  let depth = 0;
  while (frontier.length > 0 && (maxDepth === undefined || depth < maxDepth)) {
    const next: AnchorId[] = [];
    for (const anchor of frontier) {
      const callees = await ctx.graph.neighbors(anchor, "calls");
      for (const node of callees) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        next.push(node.id);
      }
    }
    frontier = next;
    depth += 1;
  }
  return seen;
}
