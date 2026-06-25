/**
 * src/domains/view-graph.ts — Per-domain feature-unit graph aggregation.
 *
 * The Domain View collapses a domain's implementor FUNCTIONS into one node per
 * feature unit (module = vis-data `group`) and folds function→function edges
 * into weighted module→module edges. The aggregation used to run in the BROWSER
 * on every domain click, over the WHOLE function-level graph — which forced the
 * panel to download the multi-MB vis-data payload and loop O(nodes+edges) per
 * click. It is now computed ONCE per domain at prepare-web-cache time (this
 * module) and shipped in the Domain View payload, so the panel only runs the
 * cheap interactive fold step (public/domain-view-logic.js: `foldUnitGraph`)
 * over the already-aggregated module pairs.
 *
 * This is the fold-INDEPENDENT half: unit counts, colours, representative names
 * and the full set of weighted cross-module pairs. The fold (hub / weak-edge
 * removal) depends on the panel's interactive toggle, so it stays client-side.
 *
 * SRP: pure aggregation (data → data). No DOM, no vis-network, no HTTP, no fold.
 */

/** Minimal vis-data node shape the aggregation reads (a structural subset). */
export interface UnitGraphNode {
  /** Anchor id — matches a domain's implementor ids and the edges' from/to. */
  id: string;
  /** Feature unit (directory/module the node belongs to). */
  group?: string;
  /** Node colour; its `background` becomes the unit colour. */
  color?: { background?: string };
  /** Display label (fallback name when `_meta.name` is absent). */
  label?: string;
  /** Detail metadata; `name` is the preferred representative function name. */
  _meta?: { name?: string };
}

/** Minimal vis-data edge shape (function→function). */
export interface UnitGraphEdge {
  from: string;
  to: string;
}

/** One feature unit (module) after collapsing a domain's implementor functions. */
export interface UnitInfo {
  /** #implementor functions of this domain that live in the unit. */
  count: number;
  /** The unit's vis-data colour, or null when unknown. */
  color: string | null;
  /** Representative function names (≤12) for the node tooltip. */
  fns: string[];
}

/** The fold-independent per-domain unit graph (precomputed, shipped to panel). */
export interface DomainUnitGraph {
  /** Units to render, truncated to the top `maxUnits` by function count. */
  units: string[];
  /** Unit metadata, only for the rendered (`units`) groups. */
  unit: Record<string, UnitInfo>;
  /** All weighted cross-module pairs among the rendered units. */
  pairs: Array<{ from: string; to: string; w: number }>;
  /** Total feature units before truncation (panel shows "top N of M"). */
  totalUnits: number;
  /** Total implementor functions of the domain. */
  totalFns: number;
}

/**
 * Collapse a domain's implementor functions into a feature-unit graph: one entry
 * per module (count + colour + ≤12 representative names) and function→function
 * edges aggregated into weighted, cross-module-only `pairs`. Units are truncated
 * to the top `maxUnits` by function count; edges between truncated-out units are
 * dropped so `pairs` only references rendered units.
 *
 * Mirrors the historical browser aggregation (the fold-independent half of the
 * former `buildDomainUnitGraph`) so the precomputed result is identical to what
 * the panel used to derive on the fly.
 */
export function aggregateDomainUnits(
  implementors: string[],
  nodes: UnitGraphNode[],
  edges: UnitGraphEdge[],
  opts: { maxUnits: number },
): DomainUnitGraph {
  const maxUnits = opts.maxUnits;
  const impl = new Set(implementors ?? []);

  const unitAll: Record<string, UnitInfo> = {};
  const nodeUnit = new Map<string, string>();
  for (const n of nodes ?? []) {
    if (!impl.has(n.id)) continue;
    const g = n.group || "unknown";
    nodeUnit.set(n.id, g);
    if (!unitAll[g]) unitAll[g] = { count: 0, color: n.color?.background ?? null, fns: [] };
    unitAll[g].count++;
    if (unitAll[g].fns.length < 12) unitAll[g].fns.push(n._meta?.name ?? n.label ?? n.id);
  }

  let units = Object.keys(unitAll);
  const totalUnits = units.length;
  const totalFns = (implementors ?? []).length;
  if (totalUnits > maxUnits) {
    units = units.sort((a, b) => unitAll[b]!.count - unitAll[a]!.count).slice(0, maxUnits);
  }
  const shown = new Set(units);

  // Only ship metadata for the units we actually render.
  const unit: Record<string, UnitInfo> = {};
  for (const g of units) unit[g] = unitAll[g]!;

  // Aggregate implementor edges into module→module, weighted, cross-module only.
  const agg = new Map<string, Map<string, number>>();
  for (const e of edges ?? []) {
    const ga = nodeUnit.get(e.from);
    const gb = nodeUnit.get(e.to);
    if (!ga || !gb || ga === gb) continue;
    if (!shown.has(ga) || !shown.has(gb)) continue;
    let row = agg.get(ga);
    if (!row) agg.set(ga, (row = new Map()));
    row.set(gb, (row.get(gb) ?? 0) + 1);
  }
  const pairs: Array<{ from: string; to: string; w: number }> = [];
  for (const [from, row] of agg) {
    for (const [to, w] of row) pairs.push({ from, to, w });
  }

  return { units, unit, pairs, totalUnits, totalFns };
}
