/**
 * Shared vis-network data builder.
 *
 * The function graph remains the analysis source of truth. A class view is a
 * display projection that collapses member functions and their edges without
 * mutating or discarding the underlying function graph.
 */

import { basename, relative, dirname } from "node:path";
import { computeMetrics } from "../../supply/metrics.js";
import type { AnalysisContext } from "../../core.js";
import type { AnchorId, CodeNode, Edge, FunctionNode, UnresolvedCall } from "../../types.js";
import type { NodeMetrics } from "../../supply/metrics.js";
import { projectClassView } from "../../graph/view-projection.js";
import { defaultGraphViewForPaths, type GraphViewMode } from "../../project/profile.js";
import { resolveUnityLifecycleFunctions } from "../../frameworks/unity/lifecycle.js";

export const GROUP_PALETTE: readonly string[] = [
  "#58a6ff", "#3fb950", "#d29922", "#f78166", "#bc8cff",
  "#39c5cf", "#e3b341", "#ff7b72", "#7ee787", "#ffa657",
  "#79c0ff", "#56d364", "#e3b341", "#ffa28b", "#d2a8ff",
];

export const EDGE_COLORS: Record<string, string> = {
  calls: "#58a6ff", reads: "#3fb950", writes: "#d29922",
  depends: "#bc8cff", implements: "#39c5cf", overrides: "#ffa657",
  includes: "#f78166",
};

export interface VisNodeMeta {
  name: string;
  kind: string;
  file: string;
  line: number;
  domain: string | null;
  coupling: number;
  cyclomatic: number;
  fanIn: number;
  fanOut: number;
  domainOverlap: number;
  crossDomainDepth: number;
  /** Function anchors represented by this node (one for function view). */
  memberAnchors: string[];
  memberCount: number;
  /** Unity event-function label; null outside resolved MonoBehaviour lifecycle. */
  lifecycle: string | null;
  lifecyclePhase: string | null;
  /** All Unity lifecycle events represented by a collapsed class node. */
  lifecycleEvents: string[];
}

export interface VisNode {
  id: string;
  label: string;
  title: string;
  group: string;
  color: {
    background: string;
    border: string;
    highlight: { background: string; border: string };
  };
  size: number;
  font: { color: string; size: number };
  _meta: VisNodeMeta;
}

export interface VisEdge {
  from: string;
  to: string;
  label: string;
  arrows: string;
  font: { size: number; color: string; strokeWidth: number };
  color: { color: string; opacity: number };
  width: number;
  /** Number of function edges represented by a class edge. */
  memberEdgeCount?: number;
}

export interface VisSummary {
  title: string;
  fileCount: number;
  funcCount: number;
  nodeCount: number;
  edgeCount: number;
  groupCount: number;
  unresolvedCount: number;
  viewMode?: GraphViewMode;
}

export interface VisGraphView {
  nodes: VisNode[];
  edges: VisEdge[];
  groups: string[];
  groupColors: Record<string, string>;
  legend: { group: string; color: string }[];
  summary: VisSummary;
}

export interface VisData extends VisGraphView {
  /**
   * The top-level fields (from `extends VisGraphView`) ARE the function graph and
   * are its single canonical copy — read in-process by the domain-view builder
   * and served as the "function" view by the panel/export. To avoid serializing
   * that graph twice, `views` carries only the OTHER projections (the class
   * view); a consumer selecting the function view falls back to the top level
   * when `views[mode]` is absent (see export.ts / public panel).
   */
  unresolved: UnresolvedCall[];
  defaultView: GraphViewMode;
  views: { class: VisGraphView } & Partial<Record<GraphViewMode, VisGraphView>>;
}

export function buildGroupColorMap(groups: string[]): Record<string, string> {
  const unique = [...new Set(groups)].sort();
  const map: Record<string, string> = {};
  unique.forEach((g, i) => {
    map[g] = GROUP_PALETTE[i % GROUP_PALETTE.length] as string;
  });
  return map;
}

export function groupFor(filePath: string, repoPath: string): string {
  try {
    const rel = relative(repoPath, filePath).replace(/\\/g, "/");
    const parts = rel.split("/");
    if (parts.length >= 2) return parts.slice(0, -1).join("/");
    return basename(filePath, ".ts")
      .replace(/\.tsx$/, "")
      .replace(/\.cpp$/, "")
      .replace(/\.h$/, "")
      .replace(/\.cs$/, "");
  } catch {
    return dirname(filePath);
  }
}

export function sizeForCyclomatic(cyclomatic: number): number {
  return Math.max(8, Math.min(32, 8 + cyclomatic * 2));
}

interface VisBuildOptions {
  moduleResolver?: (relPath: string, name: string) => string | null;
}

function relPath(repoPath: string, filePath: string): string {
  try {
    return relative(repoPath, filePath).replace(/\\/g, "/");
  } catch {
    return filePath;
  }
}

function borderFor(coupling: number): string {
  return coupling >= 10 ? "#da3633" : coupling >= 4 ? "#d29922" : "#238636";
}

function groupsFor(
  repoPath: string,
  nodes: readonly { id: string; name: string; filePath: string }[],
  resolver?: (relPath: string, name: string) => string | null,
): { byId: Map<string, string>; groups: string[]; colors: Record<string, string> } {
  const byId = new Map<string, string>();
  for (const node of nodes) {
    const resolved = resolver?.(relPath(repoPath, node.filePath), node.name) ?? null;
    byId.set(node.id, resolved ?? groupFor(node.filePath, repoPath));
  }
  const groups = [...new Set(byId.values())].sort();
  return { byId, groups, colors: buildGroupColorMap(groups) };
}

function edgeStyle(from: string, to: string, kind: string, count = 1): VisEdge {
  return {
    from,
    to,
    label: count > 1 ? `${kind} ×${count}` : kind,
    arrows: "to",
    font: { size: 8, color: "#6e7681", strokeWidth: 0 },
    color: { color: EDGE_COLORS[kind] ?? "#8b949e", opacity: 0.55 },
    width: Math.min(5, 1 + Math.log2(count)),
    ...(count > 1 ? { memberEdgeCount: count } : {}),
  };
}

function summaryFor(
  title: string,
  ctx: AnalysisContext,
  viewMode: GraphViewMode,
  view: Pick<VisGraphView, "nodes" | "edges" | "groups">,
  unresolvedCount: number,
): VisSummary {
  return {
    title,
    fileCount: ctx.files.length,
    funcCount: ctx.functions.length,
    nodeCount: view.nodes.length,
    edgeCount: view.edges.length,
    groupCount: view.groups.length,
    unresolvedCount,
    viewMode,
  };
}

export async function buildVisData(
  ctx: AnalysisContext,
  title?: string,
  opts?: VisBuildOptions,
): Promise<VisData> {
  const membershipMap = new Map<string, AnchorId[]>();
  for (const d of ctx.domains ?? []) membershipMap.set(d.domain, d.implementors);
  const metrics: NodeMetrics[] = await computeMetrics(ctx.graph, membershipMap);
  const metricsByAnchor = new Map(metrics.map((m) => [m.anchor, m]));
  const lifecycleByAnchor = resolveUnityLifecycleFunctions(ctx);

  const nodes: CodeNode[] = await ctx.graph.allNodes();
  const edgeMap = new Map<string, Edge>();
  for (const node of nodes) {
    for (const edge of await ctx.graph.edgesFrom(node.id)) {
      const key = `${edge.from}|${edge.to}|${edge.kind}`;
      if (!edgeMap.has(key)) edgeMap.set(key, edge);
    }
  }
  const edges = [...edgeMap.values()];
  const functionByAnchor = new Map<AnchorId, FunctionNode>();
  for (const fn of ctx.functions) if (fn.id) functionByAnchor.set(fn.id, fn);

  const anchorDomain = new Map<string, string>();
  for (const d of ctx.domains ?? []) {
    for (const anchor of d.implementors) {
      if (!anchorDomain.has(anchor)) anchorDomain.set(anchor, d.domain);
    }
  }

  const functionGroups = groupsFor(
    ctx.repoPath,
    nodes.map((n) => ({ id: n.id, name: n.name, filePath: n.sourceRange.filePath })),
    opts?.moduleResolver,
  );
  const functionNodes: VisNode[] = nodes.map((node) => {
    const metric = metricsByAnchor.get(node.id);
    const fn = functionByAnchor.get(node.id);
    const lifecycle = lifecycleByAnchor.get(node.id);
    const coupling = metric?.coupling ?? 0;
    const cyclomatic = metric?.cyclomatic ?? 1;
    const group = functionGroups.byId.get(node.id) ?? "unknown";
    const groupColor = functionGroups.colors[group] ?? "#8b949e";
    const file = relPath(ctx.repoPath, node.sourceRange.filePath);
    const domain = anchorDomain.get(node.id) ?? null;
    const kind = fn?.enclosingType ? "method" : node.kind;
    return {
      id: node.id,
      label: node.name,
      title: [
        node.name, `${file}:${node.sourceRange.start.line}`, `kind: ${kind}`,
        lifecycle ? `lifecycle: Unity/${lifecycle.phase}` : null,
        `coupling: ${coupling}`, `cyclomatic: ${cyclomatic}`,
        `fan-in: ${metric?.fanIn ?? 0}`, `fan-out: ${metric?.fanOut ?? 0}`,
        domain ? `domain: ${domain}` : null,
      ].filter(Boolean).join("\n"),
      group,
      color: {
        background: groupColor,
        border: lifecycle ? "#d2a8ff" : borderFor(coupling),
        highlight: { background: "#ffffff", border: "#58a6ff" },
      },
      size: sizeForCyclomatic(cyclomatic),
      font: { color: "#e1e4e8", size: 10 },
      _meta: {
        name: node.name, kind, file, line: node.sourceRange.start.line, domain,
        coupling, cyclomatic, fanIn: metric?.fanIn ?? 0, fanOut: metric?.fanOut ?? 0,
        domainOverlap: metric?.domainOverlap ?? 0,
        crossDomainDepth: metric?.crossDomainDepth ?? 0,
        memberAnchors: [node.id], memberCount: 1,
        lifecycle: lifecycle?.event ?? null,
        lifecyclePhase: lifecycle?.phase ?? null,
        lifecycleEvents: lifecycle ? [lifecycle.event] : [],
      },
    };
  });
  const functionEdges = edges.map((edge) => edgeStyle(edge.from, edge.to, edge.kind));
  const unresolved = ctx.graph.raw.unresolved ?? [];
  const displayTitle = title ?? basename(ctx.repoPath);
  const functionViewBase = {
    nodes: functionNodes,
    edges: functionEdges,
    groups: functionGroups.groups,
    groupColors: functionGroups.colors,
    legend: functionGroups.groups.map((group) => ({
      group,
      color: functionGroups.colors[group] ?? "#8b949e",
    })),
  };
  const functionView: VisGraphView = {
    ...functionViewBase,
    summary: summaryFor(displayTitle, ctx, "function", functionViewBase, unresolved.length),
  };

  const classProjection = projectClassView(ctx.repoPath, ctx.files, ctx.functions, edges);
  const classGroups = groupsFor(
    ctx.repoPath,
    classProjection.nodes.map((n) => ({ id: n.id, name: n.name, filePath: n.sourceRange.filePath })),
    opts?.moduleResolver,
  );
  const classFanIn = new Map<string, number>();
  const classFanOut = new Map<string, number>();
  for (const edge of classProjection.edges) {
    classFanOut.set(edge.from, (classFanOut.get(edge.from) ?? 0) + edge.memberEdgeCount);
    classFanIn.set(edge.to, (classFanIn.get(edge.to) ?? 0) + edge.memberEdgeCount);
  }
  const classNodes: VisNode[] = classProjection.nodes.map((node) => {
    const memberMetrics = node.memberAnchors
      .map((anchor) => metricsByAnchor.get(anchor))
      .filter((metric): metric is NodeMetrics => metric !== undefined);
    const coupling = (classFanIn.get(node.id) ?? 0) + (classFanOut.get(node.id) ?? 0);
    const cyclomatic = Math.max(1, memberMetrics.reduce((sum, metric) => sum + metric.cyclomatic, 0));
    const domains = [...new Set(node.memberAnchors.map((a) => anchorDomain.get(a)).filter(Boolean))] as string[];
    const lifecycleEvents = node.memberAnchors
      .map((anchor) => lifecycleByAnchor.get(anchor)?.event)
      .filter((event): event is string => event !== undefined)
      .sort();
    const group = classGroups.byId.get(node.id) ?? "unknown";
    const groupColor = classGroups.colors[group] ?? "#8b949e";
    const file = relPath(ctx.repoPath, node.sourceRange.filePath);
    const fanIn = classFanIn.get(node.id) ?? 0;
    const fanOut = classFanOut.get(node.id) ?? 0;
    return {
      id: node.id,
      label: node.name,
      title: [
        node.name, `${file}:${node.sourceRange.start.line}`, "kind: class",
        `members: ${node.memberAnchors.length}`, `coupling: ${coupling}`,
        `fan-in: ${fanIn}`, `fan-out: ${fanOut}`,
        lifecycleEvents.length ? `Unity lifecycle: ${lifecycleEvents.join(", ")}` : null,
        domains.length ? `domain: ${domains.join(", ")}` : null,
      ].filter(Boolean).join("\n"),
      group,
      color: {
        background: groupColor,
        border: lifecycleEvents.length ? "#d2a8ff" : borderFor(coupling),
        highlight: { background: "#ffffff", border: "#58a6ff" },
      },
      size: sizeForCyclomatic(cyclomatic),
      font: { color: "#e1e4e8", size: 10 },
      _meta: {
        name: node.name, kind: "class", file, line: node.sourceRange.start.line,
        domain: domains[0] ?? null, coupling, cyclomatic, fanIn, fanOut,
        domainOverlap: Math.max(0, domains.length - 1), crossDomainDepth: 0,
        memberAnchors: node.memberAnchors, memberCount: node.memberAnchors.length,
        lifecycle: lifecycleEvents.length ? "Unity lifecycle" : null,
        lifecyclePhase: null, lifecycleEvents,
      },
    };
  });
  const classEdges = classProjection.edges.map((edge) =>
    edgeStyle(edge.from, edge.to, edge.kind, edge.memberEdgeCount));
  const classViewBase = {
    nodes: classNodes,
    edges: classEdges,
    groups: classGroups.groups,
    groupColors: classGroups.colors,
    legend: classGroups.groups.map((group) => ({
      group,
      color: classGroups.colors[group] ?? "#8b949e",
    })),
  };
  const classView: VisGraphView = {
    ...classViewBase,
    summary: summaryFor(displayTitle, ctx, "class", classViewBase, unresolved.length),
  };

  const defaultView = ctx.projectProfile?.defaultGraphView
    ?? defaultGraphViewForPaths(ctx.files.map((file) => file.path));
  return {
    // Top-level = the function graph (single copy). `views` holds only the class
    // projection; the function view is served from the top level, so it is not
    // duplicated here (which would double the serialized payload on large repos).
    ...functionView,
    unresolved,
    defaultView,
    views: { class: classView },
  };
}
