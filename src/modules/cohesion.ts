/**
 * src/modules/cohesion.ts — Evaluate the function→module aggregation.
 *
 * Given a module partition + the code edges, score each module's cohesion and
 * surface functions that belong elsewhere (misfits). This is how we *evaluate*
 * the aggregation without reclustering: a low cohesion or a misfit is a signal
 * for the human / the Sonnet judge / a domain reconstruction — never a silent
 * regroup.
 *
 *   cohesion(m)   = internalEdges / (internalEdges + outgoingExternal)   (0..1)
 *   misfit(f)     = f ties to some other module MORE than to its home module
 *   modularity Q  = Σ_m (e_mm − a_m²)   (Newman; −0.5..1, higher = cleaner split)
 *
 * Only structural ties (calls / reads / writes) count — include/depends are
 * file-level noise for this purpose.
 *
 * SRP: scoring only. Partitioning is build.ts.
 */

import type { AnchorId, Edge } from "../types.js";
import type { ModuleUnit, ModuleCohesion, MisfitFunction, ModuleEvaluation, ModuleGranularity } from "./types.js";

const TIE_KINDS = new Set(["calls", "reads", "writes"]);

/** Keep only structural-tie edges whose endpoints are both known anchors. */
function tieEdges(edges: Edge[], index: Map<AnchorId, string>): Edge[] {
  return edges.filter((e) => TIE_KINDS.has(e.kind) && index.has(e.from) && index.has(e.to));
}

/** Per-module cohesion + coupling counts. */
export function moduleCohesion(
  modules: ModuleUnit[],
  edges: Edge[],
  index: Map<AnchorId, string>,
): ModuleCohesion[] {
  const internal = new Map<string, number>();
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const e of tieEdges(edges, index)) {
    const mf = index.get(e.from)!;
    const mt = index.get(e.to)!;
    if (mf === mt) {
      internal.set(mf, (internal.get(mf) ?? 0) + 1);
    } else {
      outgoing.set(mf, (outgoing.get(mf) ?? 0) + 1);
      incoming.set(mt, (incoming.get(mt) ?? 0) + 1);
    }
  }
  return modules
    .map((m) => {
      const i = internal.get(m.id) ?? 0;
      const o = outgoing.get(m.id) ?? 0;
      const denom = i + o;
      return {
        moduleId: m.id,
        internalEdges: i,
        outgoingExternal: o,
        incomingExternal: incoming.get(m.id) ?? 0,
        cohesion: denom === 0 ? 1 : i / denom,
        size: m.anchors.length,
      };
    })
    .sort((a, b) => (a.moduleId < b.moduleId ? -1 : 1));
}

/**
 * Functions that tie to another module more strongly than to their home module.
 * Only flagged when the attracting module strictly beats the home tie count (a
 * tie to home wins ties — a function is presumed to belong where it is).
 */
export function misfitFunctions(
  modules: ModuleUnit[],
  edges: Edge[],
  index: Map<AnchorId, string>,
  nameOf: (a: AnchorId) => string,
): MisfitFunction[] {
  // For each function: ties to each module (both directions).
  const ties = new Map<AnchorId, Map<string, number>>();
  const bump = (a: AnchorId, m: string): void => {
    let inner = ties.get(a);
    if (!inner) {
      inner = new Map();
      ties.set(a, inner);
    }
    inner.set(m, (inner.get(m) ?? 0) + 1);
  };
  for (const e of tieEdges(edges, index)) {
    bump(e.from, index.get(e.to)!);
    bump(e.to, index.get(e.from)!);
  }

  const misfits: MisfitFunction[] = [];
  for (const m of modules) {
    for (const a of m.anchors) {
      const inner = ties.get(a);
      if (!inner) continue;
      const homeTies = inner.get(m.id) ?? 0;
      let best = "";
      let bestTies = homeTies;
      for (const [mod, n] of inner) {
        if (mod === m.id) continue;
        if (n > bestTies) {
          best = mod;
          bestTies = n;
        }
      }
      if (best && bestTies > homeTies) {
        misfits.push({ anchor: a, name: nameOf(a), homeModule: m.id, attractedTo: best, homeTies, attractedTies: bestTies });
      }
    }
  }
  return misfits.sort((a, b) =>
    b.attractedTies - b.homeTies !== a.attractedTies - a.homeTies
      ? b.attractedTies - b.homeTies - (a.attractedTies - a.homeTies)
      : a.anchor < b.anchor
        ? -1
        : 1,
  );
}

/** Newman modularity Q of the partition over structural-tie edges (undirected). */
export function modularity(modules: ModuleUnit[], edges: Edge[], index: Map<AnchorId, string>): number {
  const ties = tieEdges(edges, index);
  const m = ties.length;
  if (m === 0) return 0;
  // e_mm: edges within module; degree: endpoint count per module.
  const within = new Map<string, number>();
  const degree = new Map<string, number>();
  for (const e of ties) {
    const mf = index.get(e.from)!;
    const mt = index.get(e.to)!;
    degree.set(mf, (degree.get(mf) ?? 0) + 1);
    degree.set(mt, (degree.get(mt) ?? 0) + 1);
    if (mf === mt) within.set(mf, (within.get(mf) ?? 0) + 1);
  }
  let q = 0;
  for (const mod of modules) {
    const eMM = (within.get(mod.id) ?? 0) / m;
    const aM = (degree.get(mod.id) ?? 0) / (2 * m);
    q += eMM - aM * aM;
  }
  return q;
}

/** Full module evaluation = partition + cohesion + misfits + modularity. */
export function evaluateModules(
  modules: ModuleUnit[],
  edges: Edge[],
  index: Map<AnchorId, string>,
  nameOf: (a: AnchorId) => string,
  granularity: ModuleGranularity,
): ModuleEvaluation {
  return {
    granularity,
    modules,
    cohesion: moduleCohesion(modules, edges, index),
    misfits: misfitFunctions(modules, edges, index, nameOf),
    modularity: modularity(modules, edges, index),
  };
}
