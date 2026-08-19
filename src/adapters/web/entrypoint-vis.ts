/**
 * src/adapters/web/entrypoint-vis.ts — Entry forest as vis-network data.
 *
 * Reuses the graph export's renderer by producing the SAME VisData shape the
 * function graph produces — only the selection and the encoding change:
 *   - roots are entry points (larger, bordered, grouped by entry class);
 *   - edges are TREE edges, so what you see is the reach forest, not the whole
 *     call graph;
 *   - unrooted symbols are kept as a grey cluster — hiding them would turn "no
 *     entry reaches this" into an invisible fact (spec 不変条件 3);
 *   - a frontier leaf gets a dashed stub, so "cannot follow" reads differently
 *     from "does not continue" (不変条件 4).
 *
 * SRP: EntryPointGraph → VisData. No HTML, no traversal, no persistence.
 */

import type { EntryPointGraph } from "../../entrypoints/types.js";
import {
  buildGroupColorMap,
  EDGE_COLORS,
  type VisData,
  type VisEdge,
  type VisNode,
} from "./vis-data.js";

const UNROOTED_GROUP = "unrooted";
const UNROOTED_COLOR = "#484f58";
const FRONTIER_COLOR = "#f85149";

function node(
  id: string,
  label: string,
  title: string,
  group: string,
  color: string,
  size: number,
  meta: VisNode["_meta"],
): VisNode {
  return {
    id,
    label,
    title,
    group,
    color: { background: color, border: color, highlight: { background: color, border: "#e1e4e8" } },
    size,
    font: { color: "#e1e4e8", size: 12 },
    _meta: meta,
  };
}

function meta(name: string, file: string, line: number, domain: string, anchors: string[]): VisNode["_meta"] {
  return {
    name, kind: "function", file, line, domain,
    coupling: 0, cyclomatic: 0, fanIn: 0, fanOut: 0,
    domainOverlap: 0, crossDomainDepth: 0,
    memberAnchors: anchors, memberCount: anchors.length,
    lifecycle: null, lifecyclePhase: null, lifecycleEvents: [],
  };
}

/** Build the entry-forest view. Deterministic: input order is already sorted. */
export function buildEntryPointVisData(graph: EntryPointGraph, title: string): VisData {
  const entryById = new Map(graph.entries.map((entry) => [entry.id, entry]));
  const groups = [
    ...new Set(graph.entries.flatMap((entry) => entry.classes)),
    ...(graph.unrooted.length > 0 ? [UNROOTED_GROUP] : []),
  ].sort();
  const groupColors = buildGroupColorMap(groups);
  if (graph.unrooted.length > 0) groupColors[UNROOTED_GROUP] = UNROOTED_COLOR;

  const nodes: VisNode[] = [];
  const edges: VisEdge[] = [];

  for (const record of graph.nodes) {
    const entry = entryById.get(record.anchor);
    // A node's group is the class of the lowest entry that reaches it, so the
    // forest colours by "which way in owns this".
    const owningEntry = record.reachedFrom
      .map((id) => entryById.get(id))
      .find((candidate) => candidate !== undefined);
    const group = entry?.classes[0] ?? owningEntry?.classes[0] ?? UNROOTED_GROUP;
    const colour = groupColors[group] ?? UNROOTED_COLOR;
    const distances = Object.values(record.distance);
    const nearest = distances.length > 0 ? Math.min(...distances) : 0;
    const details = [
      record.path,
      entry ? `entry [${entry.classes.join(",")}]` : `+${nearest} from ${record.reachedFrom.length} entr${record.reachedFrom.length === 1 ? "y" : "ies"}`,
      record.owner ? `owner ${record.owner}` : "",
      record.programDomain ? `program ${record.programDomain}` : "",
      record.frontier.length > 0 ? `frontier ${record.frontier.length}` : "",
    ].filter(Boolean).join(" / ");
    nodes.push(node(
      record.anchor,
      record.name,
      details,
      group,
      colour,
      entry ? 26 : Math.max(10, 20 - nearest * 2),
      meta(record.name, record.path, 0, record.owner ?? record.programDomain ?? group, [record.anchor]),
    ));

    // Dashed stub per frontier drop: the leaf where static resolution gave up.
    for (const [index, drop] of record.frontier.entries()) {
      const stubId = `${record.anchor}#frontier-${index}`;
      nodes.push(node(
        stubId,
        drop.calleeName,
        `unresolved call (${drop.reason})${drop.receiverType ? ` on ${drop.receiverType}` : ""}`,
        group,
        FRONTIER_COLOR,
        8,
        meta(drop.calleeName, record.path, 0, group, []),
      ));
      edges.push({
        from: record.anchor,
        to: stubId,
        label: drop.reason,
        arrows: "to",
        font: { size: 9, color: FRONTIER_COLOR, strokeWidth: 0 },
        color: { color: FRONTIER_COLOR, opacity: 0.5 },
        width: 1,
        dashes: true,
      });
    }
  }

  for (const record of graph.unrooted) {
    nodes.push(node(
      record.anchor,
      record.name,
      `${record.path} / unrooted (no entry reaches this)`,
      UNROOTED_GROUP,
      UNROOTED_COLOR,
      8,
      meta(record.name, record.path, 0, UNROOTED_GROUP, [record.anchor]),
    ));
  }

  for (const edge of graph.edges) {
    edges.push({
      from: edge.from,
      to: edge.to,
      label: "",
      arrows: "to",
      font: { size: 9, color: "#8b949e", strokeWidth: 0 },
      color: { color: EDGE_COLORS[edge.kind] ?? "#58a6ff", opacity: 0.7 },
      width: Math.min(4, edge.onTreeOf.length),
    });
  }

  const view = {
    nodes,
    edges,
    groups,
    groupColors,
    legend: groups.map((group) => ({ group, color: groupColors[group] ?? UNROOTED_COLOR })),
    summary: {
      title,
      fileCount: new Set(graph.nodes.map((record) => record.path)).size,
      funcCount: graph.nodes.length + graph.unrooted.length,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      groupCount: groups.length,
      unresolvedCount: graph.nodes.reduce((total, record) => total + record.frontier.length, 0),
    },
  };
  return { ...view, unresolved: [], defaultView: "function", views: { class: view } };
}
