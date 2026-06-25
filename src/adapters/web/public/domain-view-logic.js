/**
 * domain-view-logic.js — pure data-shaping for the Domain View panel.
 *
 * The panel's `renderAccess` / `focusDomain` mixed real algorithm (access-row
 * shaping, feature-unit aggregation, hub / weak-edge folding) with DOM and
 * vis-network glue, leaving the logic untested. This module holds ONLY the pure
 * parts (input data → output data, no DOM, no vis), so it can be unit-tested
 * with vitest and reused verbatim by the browser.
 *
 * Loaded in the browser as an ES module (`/domain-view-logic.js`), which also
 * publishes the API on `window.DomainViewLogic` for the panel's classic inline
 * scripts. Imported directly by the test.
 */

/** Feature unit (module) a source file belongs to: its directory, else stem. */
export function unitOfFile(file) {
  const parts = String(file).split("/");
  if (parts.length >= 2) return parts.slice(0, -1).join("/");
  return parts[0].replace(/\.(tsx?|cpp|h|cs)$/, "");
}

/**
 * The access patterns (singleton / locator / facade / network) a domain touches,
 * shaped into sorted rows. For each pattern, keep only the accessors belonging
 * to `domainName`, collapse their access kinds (`reads`/`calls`) into one
 * `how` string, and sort by (kind, name).
 *
 * @returns Array<{ name, kind, target, file, how }> (empty if none touch it).
 */
export function accessRowsFor(accessPatterns, domainName) {
  const rows = (accessPatterns || [])
    .map((p) => {
      const mine = (p.accessors || []).filter((a) => a.domain === domainName);
      if (!mine.length) return null;
      const how = [...new Set(mine.map((a) => a.access))].join("/");
      return { name: p.name, kind: p.kind, target: p.target, file: p.file, how };
    })
    .filter(Boolean);
  rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return rows;
}

/**
 * Fold a precomputed per-domain feature-unit graph for display.
 *
 * The expensive half — collapsing a domain's implementor functions into feature
 * units and aggregating function→function edges into weighted module pairs — is
 * now done ONCE on the server (src/domains/view-graph.ts) and shipped in the
 * Domain View payload as `graphByDomain[domain]`. This function only applies the
 * INTERACTIVE fold (hub + weak-edge removal driven by the panel's toggle) over
 * the already-aggregated, module-level `pairs`, so it stays cheap to re-run on
 * every toggle without touching the function-level graph.
 *
 * Pure: takes the precomputed aggregate + opts, returns plain data. The caller
 * turns `agg.units`/`agg.unit` + the returned `visiblePairs` into vis.DataSets.
 *
 * @param agg  Precomputed aggregate: { units:string[], unit, pairs:[{from,to,w}],
 *             totalUnits, totalFns } (server-built; see DomainUnitGraph).
 * @param opts { fold:boolean }.
 * @returns {
 *   visiblePairs: Array<{from,to,w}>, // pairs after folding
 *   hub: Record<string,true>,         // folded hub groups
 *   degreeByGroup: Record<string,number>,
 *   foldedHubs: number, foldedEdges: number,
 * }
 */
export function foldUnitGraph(agg, opts) {
  const fold = !!(opts && opts.fold);
  const units = (agg && agg.units) || [];
  const pairs = (agg && agg.pairs) || [];

  // Degree (distinct neighbours) per unit, from the precomputed module pairs.
  const degree = {};
  pairs.forEach((p) => {
    (degree[p.from] = degree[p.from] || {})[p.to] = 1;
    (degree[p.to] = degree[p.to] || {})[p.from] = 1;
  });
  const degreeOf = (g) => (degree[g] ? Object.keys(degree[g]).length : 0);

  const dense = pairs.length > units.length;
  const EDGE_MIN = fold && dense ? 2 : 1;
  const HUB_DEGREE = Math.max(6, Math.ceil(units.length * 0.6));
  const hub = {};
  let foldedHubs = 0;
  if (fold) {
    units.forEach((g) => {
      if (degreeOf(g) >= HUB_DEGREE) { hub[g] = 1; foldedHubs++; }
    });
  }
  const visiblePairs = pairs.filter((p) => {
    if (p.w < EDGE_MIN) return false;
    if (hub[p.from] || hub[p.to]) return false;
    return true;
  });
  const foldedEdges = pairs.length - visiblePairs.length;

  const degreeByGroup = {};
  units.forEach((g) => { degreeByGroup[g] = degreeOf(g); });

  return { visiblePairs, hub, degreeByGroup, foldedHubs, foldedEdges };
}

// Publish for the panel's classic inline scripts when loaded in a browser.
if (typeof window !== "undefined") {
  window.DomainViewLogic = { unitOfFile, accessRowsFor, foldUnitGraph };
}
