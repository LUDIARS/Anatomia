/**
 * src/adapters/web/vis-data.ts — Shared vis-network data builder.
 *
 * buildVisData() converts an AnalysisContext into the vis-network JSON payload
 * consumed by both:
 *   - export.ts  (inlined as JSON in the static self-contained HTML export)
 *   - GET /api/projects/:id/vis-data  (live panel, same data structure)
 *
 * Visual encoding (mirrors DESIGN §8 / T50):
 *   - Node colour  : file group (directory/module) — distinct palette colour
 *   - Node size    : cyclomatic complexity (larger = more complex)
 *   - Node border  : coupling — red ≥10, orange ≥4, green <4
 *   - Edges        : colour by kind (calls/reads/writes/…)
 *
 * SRP: data transformation only. No HTTP, no file I/O, no HTML building.
 */

import { basename, relative, dirname } from "node:path";
import { computeMetrics } from "../../supply/metrics.js";
import type { AnalysisContext } from "../../core.js";
import type { AnchorId, CodeNode, Edge, UnresolvedCall } from "../../types.js";
import type { NodeMetrics } from "../../supply/metrics.js";

// ---------------------------------------------------------------------------
// Colour palette (same as existing Anatomia dark theme)
// ---------------------------------------------------------------------------

export const GROUP_PALETTE: readonly string[] = [
  "#58a6ff", "#3fb950", "#d29922", "#f78166", "#bc8cff",
  "#39c5cf", "#e3b341", "#ff7b72", "#7ee787", "#ffa657",
  "#79c0ff", "#56d364", "#e3b341", "#ffa28b", "#d2a8ff",
];

export const EDGE_COLORS: Record<string, string> = {
  calls:      "#58a6ff",
  reads:      "#3fb950",
  writes:     "#d29922",
  depends:    "#bc8cff",
  implements: "#39c5cf",
  overrides:  "#ffa657",
  includes:   "#f78166",
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
  /** Extra data for the detail panel — not used by vis-network itself. */
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
}

export interface VisSummary {
  title: string;
  fileCount: number;
  funcCount: number;
  nodeCount: number;
  edgeCount: number;
  groupCount: number;
  /** Count of call sites whose edges static resolution dropped (B-6). */
  unresolvedCount: number;
}

export interface VisData {
  nodes: VisNode[];
  edges: VisEdge[];
  groups: string[];
  groupColors: Record<string, string>;
  legend: { group: string; color: string }[];
  /**
   * Dropped call sites (CodeGraph.unresolved, already sorted/deduped) — the
   * static layer's honest record of edges it refused to guess. Exported so the
   * dynamic layer / users can audit them (spec/feature/dynamic-edge-recovery.md).
   */
  unresolved: UnresolvedCall[];
  summary: VisSummary;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Map each unique group name to a stable palette colour. */
export function buildGroupColorMap(groups: string[]): Record<string, string> {
  const unique = [...new Set(groups)].sort();
  const map: Record<string, string> = {};
  unique.forEach((g, i) => {
    map[g] = GROUP_PALETTE[i % GROUP_PALETTE.length] as string;
  });
  return map;
}

/**
 * Derive a short "group" label from a file path (the directory segment above
 * the file, or the filename stem for top-level files).
 */
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

/** Clamp cyclomatic complexity to a vis-network node size (8–32px). */
export function sizeForCyclomatic(cyclomatic: number): number {
  return Math.max(8, Math.min(32, 8 + cyclomatic * 2));
}

// ---------------------------------------------------------------------------
// buildVisData
// ---------------------------------------------------------------------------

/**
 * Build the full vis-network data payload for an AnalysisContext.
 *
 * The returned object is JSON-serializable and ready to be:
 *   - inlined as `var DATA = ...` in a static HTML export, OR
 *   - returned directly as `c.json(data)` from an API route.
 *
 * @param ctx    Analysis context to visualise.
 * @param title  Optional display title (defaults to repo basename).
 * @param opts   Optional `moduleResolver` (domain-retune): map a node's
 *               repo-relative path + name to a curated module name. When it
 *               returns a value, that module drives the node's `group` (colour /
 *               domain-view aggregation) instead of the raw directory; null
 *               falls back to `groupFor`.
 */
export async function buildVisData(
  ctx: AnalysisContext,
  title?: string,
  opts?: { moduleResolver?: (relPath: string, name: string) => string | null },
): Promise<VisData> {
  // --- Compute metrics ---
  const membershipMap = new Map<string, AnchorId[]>();
  for (const d of ctx.domains ?? []) {
    membershipMap.set(d.domain, d.implementors);
  }
  const metrics: NodeMetrics[] = await computeMetrics(ctx.graph, membershipMap);
  const metricsByAnchor = new Map(metrics.map((m) => [m.anchor, m]));

  // --- Collect graph data ---
  const nodes: CodeNode[] = await ctx.graph.allNodes();
  const edgeMap = new Map<string, Edge>();
  for (const node of nodes) {
    const edges = await ctx.graph.edgesFrom(node.id);
    for (const e of edges) {
      const key = `${e.from}|${e.to}|${e.kind}`;
      if (!edgeMap.has(key)) edgeMap.set(key, e);
    }
  }
  const edges = Array.from(edgeMap.values());

  // --- Domain lookup: anchor → first domain name ---
  const anchorDomain = new Map<string, string>();
  for (const d of ctx.domains ?? []) {
    for (const anchor of d.implementors) {
      if (!anchorDomain.has(anchor)) anchorDomain.set(anchor, d.domain);
    }
  }

  // --- Derive groups ---
  // A curated taxonomy module (domain-retune) wins over the raw directory group;
  // when no resolver is supplied, or it returns null, fall back to groupFor.
  const resolver = opts?.moduleResolver;
  const nodeGroup = new Map<string, string>();
  for (const n of nodes) {
    let group: string | null = null;
    if (resolver) {
      const rel = (() => {
        try {
          return relative(ctx.repoPath, n.sourceRange.filePath).replace(/\\/g, "/");
        } catch {
          return n.sourceRange.filePath;
        }
      })();
      group = resolver(rel, n.name);
    }
    nodeGroup.set(n.id, group ?? groupFor(n.sourceRange.filePath, ctx.repoPath));
  }
  const allGroups = [...new Set(nodeGroup.values())].sort();
  const groupColorMap = buildGroupColorMap(allGroups);

  // --- Build vis nodes ---
  const visNodes: VisNode[] = nodes.map((n) => {
    const m = metricsByAnchor.get(n.id);
    const coupling = m?.coupling ?? 0;
    const cyclomatic = m?.cyclomatic ?? 1;
    const group = nodeGroup.get(n.id) ?? "unknown";
    const groupColor = groupColorMap[group] ?? "#8b949e";

    const borderColor =
      coupling >= 10 ? "#da3633" : coupling >= 4 ? "#d29922" : "#238636";

    const relPath = (() => {
      try {
        return relative(ctx.repoPath, n.sourceRange.filePath).replace(/\\/g, "/");
      } catch {
        return n.sourceRange.filePath;
      }
    })();

    const domain = anchorDomain.get(n.id) ?? null;

    return {
      id: n.id,
      label: n.name,
      title: [
        n.name,
        relPath + ":" + n.sourceRange.start.line,
        "kind: " + n.kind,
        "coupling: " + coupling,
        "cyclomatic: " + cyclomatic,
        "fan-in: " + (m?.fanIn ?? 0),
        "fan-out: " + (m?.fanOut ?? 0),
        domain ? "domain: " + domain : null,
      ]
        .filter(Boolean)
        .join("\n"),
      group,
      color: {
        background: groupColor,
        border: borderColor,
        highlight: { background: "#ffffff", border: "#58a6ff" },
      },
      size: sizeForCyclomatic(cyclomatic),
      font: { color: "#e1e4e8", size: 10 },
      _meta: {
        name: n.name,
        kind: n.kind,
        file: relPath,
        line: n.sourceRange.start.line,
        domain,
        coupling,
        cyclomatic,
        fanIn: m?.fanIn ?? 0,
        fanOut: m?.fanOut ?? 0,
        domainOverlap: m?.domainOverlap ?? 0,
        crossDomainDepth: m?.crossDomainDepth ?? 0,
      },
    };
  });

  // --- Build vis edges ---
  const visEdges: VisEdge[] = edges.map((e) => ({
    from: e.from,
    to: e.to,
    label: e.kind,
    arrows: "to",
    font: { size: 8, color: "#6e7681", strokeWidth: 0 },
    color: { color: EDGE_COLORS[e.kind] ?? "#8b949e", opacity: 0.55 },
    width: 1,
  }));

  const t = title ?? basename(ctx.repoPath);
  const legendItems = allGroups.map((g) => ({
    group: g,
    color: groupColorMap[g] ?? "#8b949e",
  }));

  // Dropped call sites, straight from the built graph (sorted/deduped there).
  const unresolved: UnresolvedCall[] = ctx.graph.raw.unresolved ?? [];

  return {
    nodes: visNodes,
    edges: visEdges,
    groups: allGroups,
    groupColors: groupColorMap,
    legend: legendItems,
    unresolved,
    summary: {
      title: t,
      fileCount: ctx.files.length,
      funcCount: ctx.functions.length,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      groupCount: allGroups.length,
      unresolvedCount: unresolved.length,
    },
  };
}
