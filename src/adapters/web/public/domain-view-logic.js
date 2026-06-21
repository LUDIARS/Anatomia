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
 * Collapse a domain's implementor functions into a feature-unit graph: one node
 * per module (with function count + colour), function→function edges aggregated
 * into module→module edges weighted by crossing count, then optionally fold out
 * cross-cutting hubs and weak links so the layout isn't a hairball.
 *
 * Pure: takes vis-data nodes/edges (plain objects) + the domain's implementor
 * anchors, returns plain data. The caller turns this into vis.DataSets + DOM.
 *
 * @param implementors AnchorId[] of the selected domain.
 * @param nodes        vis-data nodes: { id, group, color:{background}, label, _meta? }.
 * @param edges        vis-data edges: { from, to }.
 * @param opts         { fold:boolean, maxUnits:number }.
 * @returns {
 *   units: string[],                  // groups to render (truncated to maxUnits by count)
 *   unit: Record<string,{count,color,fns:string[]}>,
 *   nodeUnit: Record<string,string>,  // implementor nodeId → group
 *   pairs: Array<{from,to,w}>,        // all cross-module edges
 *   visiblePairs: Array<{from,to,w}>, // after folding
 *   hub: Record<string,true>,         // folded hub groups
 *   degreeByGroup: Record<string,number>,
 *   foldedHubs: number, foldedEdges: number,
 *   totalUnits: number, totalFns: number,
 * }
 */
export function buildDomainUnitGraph(implementors, nodes, edges, opts) {
  const fold = !!(opts && opts.fold);
  const maxUnits = opts && opts.maxUnits != null ? opts.maxUnits : 60;

  const impl = {};
  (implementors || []).forEach((a) => { impl[a] = 1; });

  const unit = {};       // group -> { count, color, fns }
  const nodeUnit = {};   // implementor nodeId -> group
  (nodes || []).forEach((n) => {
    if (!impl[n.id]) return;
    const g = n.group || "unknown";
    nodeUnit[n.id] = g;
    if (!unit[g]) unit[g] = { count: 0, color: n.color && n.color.background, fns: [] };
    unit[g].count++;
    if (unit[g].fns.length < 12) unit[g].fns.push(n._meta ? n._meta.name : n.label);
  });

  let units = Object.keys(unit);
  const totalUnits = units.length;
  const totalFns = (implementors || []).length;
  if (totalUnits > maxUnits) {
    units = units.sort((a, b) => unit[b].count - unit[a].count).slice(0, maxUnits);
  }
  const shown = {};
  units.forEach((g) => { shown[g] = 1; });

  // Aggregate implementor edges into module→module, weighted, cross-module only.
  const agg = {};
  (edges || []).forEach((e) => {
    const ga = nodeUnit[e.from], gb = nodeUnit[e.to];
    if (!ga || !gb || ga === gb) return;
    if (!shown[ga] || !shown[gb]) return;
    if (!agg[ga]) agg[ga] = {};
    agg[ga][gb] = (agg[ga][gb] || 0) + 1;
  });
  const pairs = [];
  Object.keys(agg).forEach((from) => {
    Object.keys(agg[from]).forEach((to) => {
      pairs.push({ from, to, w: agg[from][to] });
    });
  });

  // Fold cross-cutting hubs + weak links (toggle).
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

  return {
    units, unit, nodeUnit, pairs, visiblePairs,
    hub, degreeByGroup, foldedHubs, foldedEdges, totalUnits, totalFns,
  };
}

// Publish for the panel's classic inline scripts when loaded in a browser.
if (typeof window !== "undefined") {
  window.DomainViewLogic = { unitOfFile, accessRowsFor, buildDomainUnitGraph };
}
