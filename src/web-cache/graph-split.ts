/**
 * src/web-cache/graph-split.ts — Split a full VisData graph into a small
 * OVERVIEW (group-granularity aggregate) plus per-group SLICES for lazy,
 * zoom-in display.
 *
 * Why: serving the whole function graph of a large repo as one payload does
 * not scale (measured: 353MB graph.json, 51k nodes / 1.2M edges — unservable
 * and unrenderable). The panel instead first shows the overview (one node per
 * group, edges aggregated and pruned to the strongest connections), and
 * fetches a single group's slice when the user zooms in.
 *
 * SRP: pure data reshaping from VisData. No file IO (store.ts) and no HTTP
 * (routes/web-cache.ts).
 */

import { createHash } from "node:crypto";
import type { GraphViewMode } from "../project/profile.js";
import type { VisData, VisEdge, VisGraphView, VisNode, VisSummary } from "../adapters/web/vis-data.js";
import { buildGroupColorMap } from "../adapters/web/vis-data.js";

/** Hard cap on aggregated overview edges (strongest kept — the 刈り取り). */
export const OVERVIEW_EDGE_CAP = 12000;
/** Per-group out-edge cap applied before the global cap. */
export const OVERVIEW_EDGES_PER_GROUP = 10;
/** Maximum real nodes retained in one lazily-fetched slice. */
export const SLICE_NODE_CAP = 4000;
/** Maximum displayed edges retained in one lazily-fetched slice. */
export const SLICE_EDGE_CAP = 20000;

/** Slice index entry: enough for the panel's group selector. */
export interface GraphSliceRef {
  /** Stable file-safe key (sha256 of the group name, 16 hex chars). */
  key: string;
  name: string;
  functionCount: number;
  classCount: number;
}

/** Group-granularity overview node (already vis-network shaped). */
export interface OverviewNode {
  id: string; // slice key
  label: string;
  title: string;
  group: string;
  color: { background: string; border: string; highlight: { background: string; border: string } };
  size: number;
  font: { color: string; size: number };
}

export interface OverviewEdge {
  from: string;
  to: string;
  label: string;
  arrows: string;
  color: { color: string; opacity: number };
  width: number;
  /** Function-edge count this aggregated edge represents. */
  memberEdgeCount: number;
}

export interface GraphOverviewPayload {
  schema: "graph-overview-v1";
  defaultView: GraphViewMode;
  /** Whole-graph summary (function granularity). */
  summary: VisSummary;
  groups: GraphSliceRef[];
  overview: { nodes: OverviewNode[]; edges: OverviewEdge[] };
  /** Aggregated group-pair edges dropped by the pruning caps (visibility). */
  prunedEdgeCount: number;
  unresolvedCount: number;
}

export interface GraphSlicePayload {
  schema: "graph-slice-v1";
  key: string;
  name: string;
  mode: GraphViewMode;
  /** The group's own nodes (full VisNode, _meta included for the detail pane). */
  nodes: VisNode[];
  /** Intra-group edges + aggregated boundary edges to/from pseudo nodes. */
  edges: VisEdge[];
  /** Pseudo nodes representing neighbour groups (id = "@group:<key>"). */
  boundary: OverviewNode[];
  /** Counts before deterministic pruning, for honest UI disclosure. */
  totalNodeCount: number;
  totalEdgeCount: number;
  prunedNodeCount: number;
  prunedEdgeCount: number;
}

export type GraphSliceMap = Record<GraphViewMode, Record<string, GraphSlicePayload>>;

/** Stable file-safe key for a group name. */
export function sliceKey(groupName: string): string {
  return createHash("sha256").update(groupName, "utf8").digest("hex").slice(0, 16);
}

/** Pseudo-node id used for a neighbour group inside a slice. */
export function boundaryNodeId(groupKey: string): string {
  return `@group:${groupKey}`;
}

function scaleSize(memberCount: number): number {
  // log scale: 1 member → 10, 1000 members → ~34.
  return Math.round(Math.min(44, 10 + Math.log2(Math.max(1, memberCount)) * 3.5));
}

function overviewNode(
  key: string,
  name: string,
  memberCount: number,
  color: string,
  extraTitle = "",
): OverviewNode {
  return {
    id: key,
    label: name,
    title: `${name}\nmembers: ${memberCount}${extraTitle}`,
    group: name,
    color: {
      background: color,
      border: "#30363d",
      highlight: { background: "#ffffff", border: "#58a6ff" },
    },
    size: scaleSize(memberCount),
    font: { color: "#e1e4e8", size: 11 },
  };
}

interface GroupAgg {
  name: string;
  key: string;
  functionCount: number;
  classCount: number;
}

/** Group membership + counts over both view modes. */
function collectGroups(visData: VisData): Map<string, GroupAgg> {
  const byName = new Map<string, GroupAgg>();
  const ensure = (name: string): GroupAgg => {
    let agg = byName.get(name);
    if (!agg) {
      agg = { name, key: sliceKey(name), functionCount: 0, classCount: 0 };
      byName.set(name, agg);
    }
    return agg;
  };
  for (const node of visData.nodes) ensure(node.group).functionCount += 1;
  for (const node of visData.views.class.nodes) ensure(node.group).classCount += 1;
  return byName;
}

function representedEdges(edge: VisEdge): number {
  return edge.memberEdgeCount ?? 1;
}

/** Keep the most connected nodes, with anchor/id as the deterministic tie-break. */
function selectSliceNodes(
  nodes: readonly VisNode[],
  degreeByNode: ReadonlyMap<string, number>,
): VisNode[] {
  return [...nodes]
    .sort((a, b) =>
      (degreeByNode.get(b.id) ?? 0) - (degreeByNode.get(a.id) ?? 0)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, SLICE_NODE_CAP)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Keep the strongest relationships while bounding the rendered payload. */
function selectSliceEdges(edges: readonly VisEdge[]): VisEdge[] {
  if (edges.length <= SLICE_EDGE_CAP) return [...edges];
  return [...edges]
    .sort((a, b) =>
      representedEdges(b) - representedEdges(a)
      || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)
      || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0)
      || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .slice(0, SLICE_EDGE_CAP);
}

/**
 * Build the group-granularity overview from the FUNCTION view (the analysis
 * source of truth). Edges are aggregated per (fromGroup, toGroup) pair and
 * pruned: per-group top-N out-edges by represented function-edge count, then
 * a global cap keeping the strongest pairs.
 */
export function buildGraphOverview(visData: VisData): GraphOverviewPayload {
  const groups = collectGroups(visData);
  const groupOfNode = new Map<string, string>();
  for (const node of visData.nodes) groupOfNode.set(node.id, node.group);

  // Aggregate cross-group edges (self-pairs are the group's internal detail).
  const pairCount = new Map<string, number>(); // "from\0to" -> function-edge count
  for (const edge of visData.edges) {
    const fromGroup = groupOfNode.get(edge.from);
    const toGroup = groupOfNode.get(edge.to);
    if (!fromGroup || !toGroup || fromGroup === toGroup) continue;
    const key = `${fromGroup}\0${toGroup}`;
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
  }

  // Per-group top-N out-edges, deterministic (count desc, then name).
  const byFrom = new Map<string, { to: string; count: number }[]>();
  for (const [pair, count] of pairCount) {
    const [from, to] = pair.split("\0") as [string, string];
    let list = byFrom.get(from);
    if (!list) {
      list = [];
      byFrom.set(from, list);
    }
    list.push({ to, count });
  }
  let kept: { from: string; to: string; count: number }[] = [];
  for (const [from, list] of byFrom) {
    list.sort((a, b) => b.count - a.count || (a.to < b.to ? -1 : 1));
    for (const entry of list.slice(0, OVERVIEW_EDGES_PER_GROUP)) {
      kept.push({ from, to: entry.to, count: entry.count });
    }
  }
  kept.sort((a, b) => b.count - a.count || (a.from < b.from ? -1 : 1) || (a.to < b.to ? -1 : 1));
  const prunedEdgeCount = pairCount.size - Math.min(kept.length, OVERVIEW_EDGE_CAP);
  kept = kept.slice(0, OVERVIEW_EDGE_CAP);

  const sortedGroups = [...groups.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  const colors = buildGroupColorMap(sortedGroups.map((g) => g.name));
  const nodes = sortedGroups.map((g) =>
    overviewNode(g.key, g.name, g.functionCount, colors[g.name] ?? "#8b949e",
      `\nダブルクリックでズームイン`));
  const keyOf = (name: string): string => groups.get(name)!.key;
  const edges: OverviewEdge[] = kept.map((e) => ({
    from: keyOf(e.from),
    to: keyOf(e.to),
    label: e.count > 1 ? `×${e.count}` : "",
    arrows: "to",
    color: { color: "#58a6ff", opacity: 0.35 },
    width: Math.min(6, 1 + Math.log2(e.count)),
    memberEdgeCount: e.count,
  }));

  return {
    schema: "graph-overview-v1",
    defaultView: visData.defaultView,
    summary: visData.summary,
    groups: sortedGroups.map((g) => ({
      key: g.key,
      name: g.name,
      functionCount: g.functionCount,
      classCount: g.classCount,
    })),
    overview: { nodes, edges },
    prunedEdgeCount,
    unresolvedCount: visData.summary.unresolvedCount,
  };
}

/** Build one mode's slices from that mode's view. */
function slicesForView(
  view: VisGraphView,
  mode: GraphViewMode,
  allGroupNames: readonly string[],
): Record<string, GraphSlicePayload> {
  const groupOfNode = new Map<string, string>();
  const nodesByGroup = new Map<string, VisNode[]>();
  for (const node of view.nodes) {
    groupOfNode.set(node.id, node.group);
    let list = nodesByGroup.get(node.group);
    if (!list) {
      list = [];
      nodesByGroup.set(node.group, list);
    }
    list.push(node);
  }
  // Rank oversized groups by represented degree so deterministic pruning keeps
  // the most connected nodes instead of an arbitrary source-order prefix.
  const degreeByNode = new Map<string, number>();
  for (const edge of view.edges) {
    const weight = representedEdges(edge);
    degreeByNode.set(edge.from, (degreeByNode.get(edge.from) ?? 0) + weight);
    degreeByNode.set(edge.to, (degreeByNode.get(edge.to) ?? 0) + weight);
  }
  // A declaration-only group can exist only in class mode. Still emit an empty
  // function slice (and vice versa) so overview zoom and mode toggling never
  // address a missing prepared file.
  const groupNames = [...allGroupNames];
  for (const name of groupNames) {
    if (!nodesByGroup.has(name)) nodesByGroup.set(name, []);
  }
  const colors = buildGroupColorMap(groupNames);

  interface SliceBuild {
    payload: GraphSlicePayload;
    /** neighbour group name -> aggregated counts (for boundary sizing). */
    neighbours: Map<string, number>;
  }
  const builds = new Map<string, SliceBuild>();
  const selectedNodeIds = new Set<string>();
  for (const name of groupNames) {
    const allNodes = nodesByGroup.get(name)!;
    const selectedNodes = selectSliceNodes(allNodes, degreeByNode);
    for (const node of selectedNodes) selectedNodeIds.add(node.id);
    builds.set(name, {
      payload: {
        schema: "graph-slice-v1",
        key: sliceKey(name),
        name,
        mode,
        nodes: selectedNodes,
        edges: [],
        boundary: [],
        totalNodeCount: allNodes.length,
        totalEdgeCount: 0,
        prunedNodeCount: allNodes.length - selectedNodes.length,
        prunedEdgeCount: 0,
      },
      neighbours: new Map(),
    });
  }

  // Boundary edges are aggregated per (node, neighbour group) so a hub node
  // shows ONE edge per foreign group instead of hundreds of function edges.
  const boundaryAgg = new Map<string, Map<string, { count: number; out: boolean; node: string; other: string }>>();
  const bumpBoundary = (group: string, node: string, other: string, out: boolean, count: number): void => {
    let perGroup = boundaryAgg.get(group);
    if (!perGroup) {
      perGroup = new Map();
      boundaryAgg.set(group, perGroup);
    }
    const key = `${node}\0${other}\0${out ? "o" : "i"}`;
    const entry = perGroup.get(key);
    if (entry) entry.count += count;
    else perGroup.set(key, { count, out, node, other });
    const build = builds.get(group)!;
    build.neighbours.set(other, (build.neighbours.get(other) ?? 0) + count);
  };

  for (const edge of view.edges) {
    const fromGroup = groupOfNode.get(edge.from);
    const toGroup = groupOfNode.get(edge.to);
    if (!fromGroup || !toGroup) continue;
    const weight = representedEdges(edge);
    if (fromGroup === toGroup) {
      const payload = builds.get(fromGroup)!.payload;
      payload.totalEdgeCount += weight;
      if (selectedNodeIds.has(edge.from) && selectedNodeIds.has(edge.to)) {
        payload.edges.push(edge);
      }
    } else {
      builds.get(fromGroup)!.payload.totalEdgeCount += weight;
      builds.get(toGroup)!.payload.totalEdgeCount += weight;
      if (selectedNodeIds.has(edge.from)) {
        bumpBoundary(fromGroup, edge.from, toGroup, true, weight);
      }
      if (selectedNodeIds.has(edge.to)) {
        bumpBoundary(toGroup, edge.to, fromGroup, false, weight);
      }
    }
  }

  const out: Record<string, GraphSlicePayload> = {};
  for (const [name, build] of builds) {
    // Pseudo nodes for neighbour groups, sized by how many function edges lead there.
    const neighbourNames = [...build.neighbours.keys()].sort();
    for (const neighbour of neighbourNames) {
      build.payload.boundary.push(
        overviewNode(
          boundaryNodeId(sliceKey(neighbour)),
          neighbour,
          build.neighbours.get(neighbour) ?? 1,
          colors[neighbour] ?? "#484f58",
          `\n隣接グループ（ダブルクリックで移動）`,
        ),
      );
    }
    const perGroup = boundaryAgg.get(name);
    if (perGroup) {
      const entries = [...perGroup.values()].sort((a, b) =>
        b.count - a.count
        || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0)
        || (a.other < b.other ? -1 : a.other > b.other ? 1 : 0));
      for (const entry of entries) {
        const pseudo = boundaryNodeId(sliceKey(entry.other));
        build.payload.edges.push({
          from: entry.out ? entry.node : pseudo,
          to: entry.out ? pseudo : entry.node,
          label: entry.count > 1 ? `×${entry.count}` : "",
          arrows: "to",
          font: { size: 8, color: "#6e7681", strokeWidth: 0 },
          color: { color: "#8b949e", opacity: 0.4 },
          width: Math.min(4, 1 + Math.log2(entry.count)),
          memberEdgeCount: entry.count,
        });
      }
    }
    build.payload.edges = selectSliceEdges(build.payload.edges);
    const representedEdgeCount = build.payload.edges.reduce(
      (sum, edge) => sum + representedEdges(edge),
      0,
    );
    build.payload.prunedEdgeCount = Math.max(
      0,
      build.payload.totalEdgeCount - representedEdgeCount,
    );
    const usedBoundaryIds = new Set<string>();
    for (const edge of build.payload.edges) {
      if (edge.from.startsWith("@group:")) usedBoundaryIds.add(edge.from);
      if (edge.to.startsWith("@group:")) usedBoundaryIds.add(edge.to);
    }
    build.payload.boundary = build.payload.boundary.filter((node) =>
      usedBoundaryIds.has(node.id));
    out[build.payload.key] = build.payload;
  }
  return out;
}

/** Build every slice for both view modes. */
export function buildGraphSlices(visData: VisData): GraphSliceMap {
  const allGroupNames = [...collectGroups(visData).keys()].sort();
  return {
    function: slicesForView(
      { nodes: visData.nodes, edges: visData.edges, groups: visData.groups,
        groupColors: visData.groupColors, legend: visData.legend, summary: visData.summary },
      "function",
      allGroupNames,
    ),
    class: slicesForView(visData.views.class, "class", allGroupNames),
  };
}
