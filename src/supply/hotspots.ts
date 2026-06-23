/**
 * src/supply/hotspots.ts — Top-N hotspot rows (coupling / complexity).
 *
 * The "hotspots" view ranks functions by coupling then cyclomatic complexity and
 * shapes each into a panel row (name, file:line, the metric columns). Extracted
 * from the web route so the same rows feed BOTH the live route and the prepared
 * web cache (web-cache/build.ts) without duplicating the metrics walk.
 *
 * SRP: metrics → ranked rows. No HTTP, no caching.
 */

import { relative } from "node:path";
import { computeMetrics } from "./metrics.js";
import type { AnalysisContext } from "../core.js";
import type { AnchorId } from "../types.js";

/** Default number of hotspot rows surfaced. */
export const HOTSPOTS_TOP_N = 20;

/** One ranked hotspot row (panel shape). */
export interface HotspotRow {
  anchor: AnchorId;
  name: string;
  file: string;
  line: number;
  coupling: number;
  cyclomatic: number;
  fanIn: number;
  fanOut: number;
  domainOverlap: number;
  crossDomainDepth: number;
}

/** Rank a context's functions by coupling then cyclomatic, top `topN`. */
export async function buildHotspots(
  ctx: AnalysisContext,
  topN: number = HOTSPOTS_TOP_N,
): Promise<HotspotRow[]> {
  const membershipMap = new Map<string, AnchorId[]>();
  for (const d of ctx.domains ?? []) {
    membershipMap.set(d.domain, d.implementors);
  }
  const metrics = await computeMetrics(ctx.graph, membershipMap);
  const nodes = await ctx.graph.allNodes();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const sorted = [...metrics]
    .sort((a, b) => b.coupling - a.coupling || b.cyclomatic - a.cyclomatic)
    .slice(0, topN);

  return sorted.map((m) => {
    const node = nodeById.get(m.anchor);
    const relPath = node
      ? (() => {
          try {
            return relative(ctx.repoPath, node.sourceRange.filePath).replace(/\\/g, "/");
          } catch {
            return node.sourceRange.filePath;
          }
        })()
      : "";
    return {
      anchor: m.anchor,
      name: node?.name ?? m.anchor,
      file: relPath,
      line: node?.sourceRange.start.line ?? 0,
      coupling: m.coupling,
      cyclomatic: m.cyclomatic,
      fanIn: m.fanIn,
      fanOut: m.fanOut,
      domainOverlap: m.domainOverlap,
      crossDomainDepth: m.crossDomainDepth,
    };
  });
}
