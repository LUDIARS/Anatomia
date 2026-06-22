/**
 * src/integral/search.ts — Phase A: the deterministic integral search.
 *
 * Walks the containment chain from the user's entry point outward, bounded by
 * the exploration range, and assembles the layer-aware necessity bundle. NO LLM,
 * NO embeddings — pure graph + domain + scene lookups, so it is cache-safe and
 * fast (effort target ≤10s; in practice milliseconds on a warm graph). The
 * Sonnet judge (agent.ts) decides afterwards whether this bundle is more or less
 * than the task needs.
 *
 * The climb (range.climb) selects how far up the chain to go:
 *   function       → seeds + their graph radius;
 *   domain         → + the domains the seeds belong to;
 *   scene          → + the scenes those domains activate;
 *   scene-adjacent → + the OTHER domains active in those scenes (default).
 *
 * SRP: traversal + assembly only. Ref resolution is resolve.ts, scene lookup is
 * scene.ts, the LLM judge is agent.ts, the path cache is cache.ts.
 */

import { createHash } from "node:crypto";
import type {
  AnchorId,
  CodeNode,
  FunctionNode,
  Link,
  Rule,
  SpecClause,
} from "../types.js";
import type { CodeGraphQuery } from "../graph/query.js";
import type { DetectionResult } from "../domains/detect.js";
import { resolveSeeds } from "./resolve.js";
import { emptySceneModel, type SceneModel, type SceneRef } from "./scene.js";
import type { ModuleEvaluation } from "../modules/types.js";
import type {
  IntegralAnchor,
  IntegralDomain,
  IntegralModule,
  IntegralQuery,
  IntegralResult,
  IntegralScene,
} from "./types.js";

/** The slice of an AnalysisContext integral search reads (structurally compatible). */
export interface IntegralContext {
  graph: CodeGraphQuery;
  domains?: DetectionResult[];
  functions?: FunctionNode[];
  specClauses?: SpecClause[];
  links?: Link[];
  rules?: Rule[];
}

const DEFAULT_MAX_HOPS = 2;
const DEFAULT_MAX_NODES = 400;
const DEFAULT_BUDGET_MS = 10_000;
const DEFAULT_CLIMB = "scene-adjacent" as const;

const CLIMB_ORDER = { function: 0, module: 1, domain: 2, scene: 3, "scene-adjacent": 4 } as const;

/** Directory of a path (fwd slashes), or "." when top-level. */
function dirOf(path: string): string {
  const f = path.replace(/\\/g, "/");
  const slash = f.lastIndexOf("/");
  return slash >= 0 ? f.slice(0, slash) : ".";
}

/** Content key over the seeds + range (the path-cache key input). */
export function integralContentKey(seeds: AnchorId[], range: unknown): string {
  const canonical = JSON.stringify({ seeds: [...seeds].sort(), range });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Run the deterministic integral search. `scenes` defaults to the empty model
 * (no dynamic data) so the search degrades to structure + domains gracefully.
 */
export async function integralSearch(
  ctx: IntegralContext,
  query: IntegralQuery,
  scenes: SceneModel = emptySceneModel(),
  moduleEval?: ModuleEvaluation,
): Promise<IntegralResult> {
  const started = Date.now();
  const range = query.range ?? {};
  const maxHops = range.maxHops ?? DEFAULT_MAX_HOPS;
  const maxNodes = range.maxNodes ?? DEFAULT_MAX_NODES;
  const budgetMs = range.budgetMs ?? DEFAULT_BUDGET_MS;
  const climb = range.climb ?? DEFAULT_CLIMB;
  const climbLevel = CLIMB_ORDER[climb];

  const domains = ctx.domains ?? [];

  // anchor → CodeNode and anchor → file, for materialisation + spec linkage.
  const allNodes = await ctx.graph.allNodes();
  const nodeById = new Map<AnchorId, CodeNode>(allNodes.map((n) => [n.id, n]));

  // Module index: anchor → moduleId. Prefer the analyze-time evaluation (carries
  // cohesion); else fall back to a directory grouping from the graph nodes.
  const moduleOf = new Map<AnchorId, string>();
  const moduleAnchors = new Map<string, AnchorId[]>();
  const moduleLabel = new Map<string, string>();
  const moduleCohesion = new Map<string, number>();
  if (moduleEval) {
    for (const m of moduleEval.modules) {
      moduleLabel.set(m.id, m.label);
      moduleAnchors.set(m.id, m.anchors);
      for (const a of m.anchors) moduleOf.set(a, m.id);
    }
    for (const c of moduleEval.cohesion) moduleCohesion.set(c.moduleId, c.cohesion);
  } else {
    for (const n of allNodes) {
      const dir = dirOf(n.sourceRange.filePath);
      moduleOf.set(n.id, dir);
      const list = moduleAnchors.get(dir) ?? [];
      list.push(n.id);
      moduleAnchors.set(dir, list);
      if (!moduleLabel.has(dir)) moduleLabel.set(dir, dir.split("/").pop() || dir);
    }
  }

  // Materialised anchors with provenance, capped at maxNodes. Earliest `via`
  // wins (seed > radius > module > domain > scene), so a seed is never relabelled.
  const VIA_RANK = { seed: 0, radius: 1, module: 2, domain: 3, scene: 4 } as const;
  const materialised = new Map<AnchorId, IntegralAnchor["via"]>();
  let truncated = false;
  let stopReason: IntegralResult["stopReason"] = "complete";

  const overBudget = (): boolean => Date.now() - started > budgetMs;

  const add = (id: AnchorId, via: IntegralAnchor["via"]): boolean => {
    const prev = materialised.get(id);
    if (prev !== undefined) {
      if (VIA_RANK[via] < VIA_RANK[prev]) materialised.set(id, via);
      return true;
    }
    if (materialised.size >= maxNodes) {
      truncated = true;
      stopReason = "maxNodes";
      return false;
    }
    materialised.set(id, via);
    return true;
  };

  // ── seeds ────────────────────────────────────────────────────────────────
  const seeds = await resolveSeeds(query.entry, { graph: ctx.graph, domains, scenes });
  const hintSeeds = query.graph?.seedAnchors ?? [];
  const allSeeds = [...new Set([...seeds, ...hintSeeds])].sort();
  for (const s of allSeeds) {
    if (nodeById.has(s)) add(s, "seed");
  }

  // ── graph radius (always, even at climb=function) ─────────────────────────
  if (!overBudget()) {
    for (const s of allSeeds) {
      if (overBudget()) {
        truncated = true;
        stopReason = "budgetMs";
        break;
      }
      const reached = await ctx.graph.reachable(s, { maxDepth: maxHops, direction: "both" });
      for (const n of reached) {
        if (!add(n.id, "radius")) break;
      }
    }
  }

  // ── module layer (機能): pull the whole module each seed lives in ─────────
  const homeModuleIds = new Set<string>();
  for (const s of allSeeds) {
    const mid = moduleOf.get(s);
    if (mid !== undefined) homeModuleIds.add(mid);
  }
  if (climbLevel >= CLIMB_ORDER.module) {
    for (const mid of homeModuleIds) {
      for (const a of moduleAnchors.get(mid) ?? []) {
        if (nodeById.has(a)) add(a, "module");
      }
    }
  }

  // ── domain layer ──────────────────────────────────────────────────────────
  // Domains the seeds belong to (a seed anchor ∈ a domain's implementors).
  const seedSet = new Set<AnchorId>(allSeeds);
  const directDomains = domains.filter((d) => d.implementors.some((a) => seedSet.has(a)));
  const knownDomainNames = new Set(query.graph?.knownDomains ?? []);
  const allDirect = domains.filter(
    (d) => directDomains.includes(d) || knownDomainNames.has(d.domain),
  );

  const surfacedDomains: IntegralDomain[] = [];
  if (climbLevel >= CLIMB_ORDER.domain) {
    for (const d of allDirect) {
      for (const a of d.implementors) {
        if (nodeById.has(a)) add(a, "domain");
      }
    }
  }

  // ── scene layer ────────────────────────────────────────────────────────────
  const surfacedScenes: IntegralScene[] = [];
  const sceneAdjacentDomainNames = new Set<string>();
  if (climbLevel >= CLIMB_ORDER.scene) {
    const sceneRefs = new Map<string, SceneRef>();
    for (const d of allDirect) {
      for (const sc of scenes.scenesForDomain(d.domain)) sceneRefs.set(sc.id, sc);
    }
    for (const id of query.graph?.knownScenes ?? []) {
      const sc = scenes.sceneById(id);
      if (sc) sceneRefs.set(sc.id, sc);
    }
    const directNames = new Set(allDirect.map((d) => d.domain));
    for (const sc of [...sceneRefs.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      // scene ≈ domain coincidence: a singleton active set already surfaced.
      const coincidesWithDomain =
        sc.domains.length === 1 && directNames.has(sc.domains[0]!) ? sc.domains[0] : undefined;
      surfacedScenes.push({ id: sc.id, label: sc.label, domains: sc.domains, coincidesWithDomain });
      if (climbLevel >= CLIMB_ORDER["scene-adjacent"]) {
        for (const dn of sc.domains) {
          if (!directNames.has(dn)) sceneAdjacentDomainNames.add(dn);
        }
      }
    }
  }

  // Scene-adjacent domains: other domains active in the surfaced scenes.
  const adjacentDomains = domains.filter((d) => sceneAdjacentDomainNames.has(d.domain));
  if (climbLevel >= CLIMB_ORDER["scene-adjacent"]) {
    for (const d of adjacentDomains) {
      for (const a of d.implementors) {
        if (nodeById.has(a)) add(a, "scene");
      }
    }
  }

  // ── assemble domain views (only those with materialised anchors) ──────────
  // Gated on the climb: the domain layer is surfaced only at climb ≥ "domain"
  // (at climb=function/module we stay below the semantic layer).
  const materialisedSet = new Set(materialised.keys());
  if (climbLevel >= CLIMB_ORDER.domain) {
    for (const d of allDirect) {
      const anchors = d.implementors.filter((a) => materialisedSet.has(a)).sort();
      if (anchors.length > 0 || directDomains.includes(d)) {
        surfacedDomains.push({ name: d.domain, via: "direct", anchors });
      }
    }
  }
  for (const d of adjacentDomains) {
    const anchors = d.implementors.filter((a) => materialisedSet.has(a)).sort();
    surfacedDomains.push({ name: d.domain, via: "scene-adjacent", anchors });
  }

  // ── assemble module views (機能 with materialised members) ────────────────
  const surfacedModuleIds = new Set<string>();
  for (const a of materialisedSet) {
    const mid = moduleOf.get(a);
    if (mid !== undefined) surfacedModuleIds.add(mid);
  }
  const modulesOut: IntegralModule[] = [...surfacedModuleIds]
    .sort()
    .map((mid) => {
      const members = (moduleAnchors.get(mid) ?? []).filter((a) => materialisedSet.has(a)).sort();
      const coh = moduleCohesion.has(mid) ? moduleCohesion.get(mid)! : null;
      return {
        id: mid,
        label: moduleLabel.get(mid) ?? mid,
        anchors: members,
        cohesion: coh,
        isHome: homeModuleIds.has(mid),
      };
    });

  // ── anchors output (sorted, with location) ────────────────────────────────
  const anchors: IntegralAnchor[] = [...materialised.entries()]
    .map(([id, via]) => {
      const n = nodeById.get(id)!;
      return {
        id,
        name: n.name,
        file: n.sourceRange.filePath,
        line: n.sourceRange.start.line,
        via,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // ── spec clauses linked to the materialised anchors / their files ─────────
  const fileSet = new Set<string>();
  for (const a of materialisedSet) {
    const n = nodeById.get(a);
    if (n) fileSet.add(n.sourceRange.filePath.replace(/\\/g, "/"));
  }
  const clauseById = new Map((ctx.specClauses ?? []).map((c) => [c.id, c]));
  const clauseIds = new Set<string>();
  for (const link of ctx.links ?? []) {
    const from = link.from as string;
    if (materialisedSet.has(link.from) || fileSet.has(from.replace(/\\/g, "/"))) {
      clauseIds.add(link.to);
    }
  }
  const specClauses = [...clauseIds]
    .map((id) => clauseById.get(id))
    .filter((c): c is SpecClause => c !== undefined)
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  // ── rules in force for the surfaced domains ───────────────────────────────
  const surfacedNames = new Set(surfacedDomains.map((d) => d.name));
  const rules: Rule[] = (ctx.rules ?? [])
    .filter((r) => surfacedNames.has(r.id.split("/")[0]!))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  if (!truncated && overBudget()) {
    truncated = true;
    stopReason = "budgetMs";
  }

  const contentKey = integralContentKey(allSeeds, range);

  return {
    query,
    seeds: allSeeds.filter((s) => nodeById.has(s)),
    anchors,
    modules: modulesOut,
    domains: dedupeDomains(surfacedDomains),
    scenes: surfacedScenes,
    specClauses,
    rules,
    truncated,
    stopReason,
    elapsedMs: Date.now() - started,
    contentKey,
  };
}

/** Collapse duplicate domain views (direct wins over scene-adjacent). */
function dedupeDomains(domains: IntegralDomain[]): IntegralDomain[] {
  const byName = new Map<string, IntegralDomain>();
  for (const d of domains) {
    const prev = byName.get(d.name);
    if (!prev || (prev.via === "scene-adjacent" && d.via === "direct")) {
      byName.set(d.name, d);
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}
