/**
 * src/review/domain-review-by-layer.ts — Per-LAYER aggregation of the domain
 * review (design §7.2 A-9).
 *
 * `domain-review` reports the taxonomy as a flat list, which answers "is this
 * domain healthy" but never "is this LAYER healthy". Layered/onion architecture
 * is reviewed a layer at a time — a thin presentation layer and a domain layer
 * full of unclassified code are different problems with different fixes — so
 * this file re-buckets the same deterministic numbers by the layer a domain's
 * code actually lives in, and counts the dependencies that point the wrong way
 * according to the repository's layer policy (A-7).
 *
 * It is a LENS, not a gate: every code path here returns a report and the CLI
 * keeps exit 0. Ordering is fully determined (declared layer order, then name),
 * so two runs over an unchanged repo print the same thing.
 *
 * SRP: aggregation only. Rendering is domain-review-format.ts; the per-domain
 * numbers come from domain-review.ts.
 *
 * @spec 層ごとのレビュー（`--by-layer`、A-9）
 */

import { relative } from "node:path";
import type { AnalysisContext } from "../core.js";
import type { AnchorId } from "../types.js";
import { buildLayerPolicy, layerOfPath, type LayerPolicy } from "../domains/program/index.js";
import type { ProgramDomainConfig } from "../domains/program/types.js";
import type { DomainReviewReport } from "./domain-review.js";

/** The bucket a function whose path matches no layer rule falls into. */
export const UNCLASSIFIED_LAYER = "(unclassified)";

/** One layer's slice of the review. */
export interface LayerReviewEntry {
  layer: string;
  /** Detection domains whose code mostly lives in this layer, sorted. */
  domains: string[];
  /** Function/method nodes whose file belongs to this layer. */
  functions: number;
  /** Of those, the ones some domain claims. */
  assigned: number;
  /** assigned / functions (0 when the layer holds no function). */
  coverage: number;
  /** Functions in this layer no domain claims. */
  unassigned: number;
  /**
   * Implementor-weighted mean of the per-domain cohesion ratios, over the
   * domains in this layer that have one. null when none does.
   */
  cohesion: number | null;
  /** calls edges leaving this layer for a layer the policy forbids. */
  violatingDependencies: number;
  /** Target layers of those edges with a count each, sorted by layer name. */
  violations: Array<{ to: string; edges: number }>;
  /** Layer-scoped review findings ("this layer is thin", ...), sorted. */
  findings: string[];
}

/** The whole by-layer lens. */
export interface DomainReviewByLayerReport {
  /** Where the layer policy came from ("builtin" when the repo declares none). */
  policySource: LayerPolicy["source"];
  /** The layer order the report is printed in. */
  layerOrder: string[];
  layers: LayerReviewEntry[];
}

/** Coverage (and cohesion) below this makes a layer "thin" in the findings. */
const THIN_RATIO = 0.5;

/** Build the by-layer lens over an already-built domain review. */
export async function buildDomainReviewByLayer(
  ctx: AnalysisContext,
  review: DomainReviewReport,
  config: ProgramDomainConfig,
): Promise<DomainReviewByLayerReport> {
  const policy = buildLayerPolicy(config);
  const nodes = await ctx.graph.allNodes();
  const rel = (path: string): string => {
    try { return relative(ctx.repoPath, path).replace(/\\/g, "/"); }
    catch { return path.replace(/\\/g, "/"); }
  };

  const layerByAnchor = new Map<AnchorId, string>();
  const functionsPerLayer = new Map<string, number>();
  for (const node of nodes) {
    if (node.kind !== "function" && node.kind !== "method") continue;
    const layer = layerOfPath(config, rel(node.sourceRange.filePath)) ?? UNCLASSIFIED_LAYER;
    layerByAnchor.set(node.id, layer);
    functionsPerLayer.set(layer, (functionsPerLayer.get(layer) ?? 0) + 1);
  }

  const claimed = new Set<AnchorId>();
  for (const detection of ctx.domains ?? []) {
    for (const anchor of detection.implementors) claimed.add(anchor);
  }

  // A domain belongs to the layer most of its implementors live in; ties go to
  // the lexicographically first layer so the assignment is reproducible.
  const domainLayer = new Map<string, string>();
  for (const detection of ctx.domains ?? []) {
    const counts = new Map<string, number>();
    for (const anchor of detection.implementors) {
      const layer = layerByAnchor.get(anchor) ?? UNCLASSIFIED_LAYER;
      counts.set(layer, (counts.get(layer) ?? 0) + 1);
    }
    const winner = [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
    domainLayer.set(detection.domain, winner?.[0] ?? UNCLASSIFIED_LAYER);
  }

  const assignedPerLayer = new Map<string, number>();
  for (const [anchor, layer] of layerByAnchor) {
    if (claimed.has(anchor)) assignedPerLayer.set(layer, (assignedPerLayer.get(layer) ?? 0) + 1);
  }

  // Forbidden dependencies, counted on the calls edges themselves so a layer's
  // number is edges, not domains.
  const violations = new Map<string, Map<string, number>>();
  for (const node of nodes) {
    const from = layerByAnchor.get(node.id);
    if (from === undefined) continue;
    for (const edge of await ctx.graph.edgesFrom(node.id, "calls")) {
      const to = layerByAnchor.get(edge.to);
      if (to === undefined || to === from) continue;
      if (policy.allows(from, to) !== false) continue;
      const perTarget = violations.get(from) ?? new Map<string, number>();
      perTarget.set(to, (perTarget.get(to) ?? 0) + 1);
      violations.set(from, perTarget);
    }
  }

  const cohesionByDomain = new Map(review.domains.map((entry) => [entry.domain, entry] as const));
  const layerNames = new Set<string>([
    ...functionsPerLayer.keys(),
    ...domainLayer.values(),
    ...violations.keys(),
  ]);
  const order = orderLayers([...layerNames], policy);
  const layers = order.map((layer): LayerReviewEntry => {
    const domains = [...domainLayer.entries()]
      .filter(([, value]) => value === layer)
      .map(([name]) => name)
      .sort();
    const functions = functionsPerLayer.get(layer) ?? 0;
    const assigned = assignedPerLayer.get(layer) ?? 0;
    const perTarget = [...(violations.get(layer) ?? new Map<string, number>()).entries()]
      .map(([to, edges]) => ({ to, edges }))
      .sort((left, right) => left.to.localeCompare(right.to));
    const weighted = domains
      .map((name) => cohesionByDomain.get(name))
      .filter((item): item is NonNullable<typeof item> => item !== undefined && item.cohesion !== null);
    const weight = weighted.reduce((sum, item) => sum + item.implementors, 0);
    const entry: LayerReviewEntry = {
      layer,
      domains,
      functions,
      assigned,
      coverage: functions === 0 ? 0 : assigned / functions,
      unassigned: functions - assigned,
      cohesion: weight === 0
        ? null
        : weighted.reduce((sum, item) => sum + (item.cohesion ?? 0) * item.implementors, 0) / weight,
      violatingDependencies: perTarget.reduce((sum, item) => sum + item.edges, 0),
      violations: perTarget,
      findings: [],
    };
    entry.findings = layerFindings(entry);
    return entry;
  });

  return { policySource: policy.source, layerOrder: order, layers };
}

/**
 * Declared layers first, in their declared order, then anything else by name,
 * with the unclassified bucket last — it is a leftover, not a layer.
 */
function orderLayers(names: string[], policy: LayerPolicy): string[] {
  const declared = policy.layers.filter((layer) => names.includes(layer));
  const rest = names
    .filter((layer) => !declared.includes(layer) && layer !== UNCLASSIFIED_LAYER)
    .sort();
  return [...declared, ...rest, ...(names.includes(UNCLASSIFIED_LAYER) ? [UNCLASSIFIED_LAYER] : [])];
}

/** Layer-scoped review findings — what a reviewer should look at in this layer. */
function layerFindings(entry: LayerReviewEntry): string[] {
  const findings: string[] = [];
  if (entry.functions > 0 && entry.coverage < THIN_RATIO) {
    findings.push(`ドメイン被覆が薄い (${entry.assigned}/${entry.functions})`);
  }
  if (entry.layer === UNCLASSIFIED_LAYER && entry.functions > 0) {
    findings.push(`層に分類されていない関数が ${entry.functions} 件ある`);
  }
  if (entry.violatingDependencies > 0) {
    findings.push(
      `層宣言に反する依存 ${entry.violatingDependencies} 件 (${entry.violations.map((item) => `${item.to}:${item.edges}`).join(", ")})`,
    );
  }
  if (entry.cohesion !== null && entry.cohesion < THIN_RATIO) {
    findings.push(`層内ドメインの凝集が低い (${entry.cohesion.toFixed(2)})`);
  }
  return findings.sort();
}
