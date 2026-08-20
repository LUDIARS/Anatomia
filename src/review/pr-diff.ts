/**
 * Ephemeral PR-diff review.
 *
 * This report is deliberately assembled from an in-memory AnalysisContext and
 * is never handed to ProjectManager or a CacheStore. Callers may serialize the
 * returned object for a single CI request, but Anatomia does not persist it.
 */

import type { AnalysisContext } from "../core.js";
import { buildVerdict } from "../core.js";
import { computeBranchDiff, type BranchDiff } from "../branch/diff.js";
import { branchDiffText } from "../branch/git.js";
import { changedFiles as changedBranchPaths } from "../branch/git.js";
import { domainsDir, loadEditableDomains } from "../domains/authoring/index.js";
import { resolveCommittedOntologyDir } from "../domains/ontology.js";
import { computeMetrics, type NodeMetrics } from "../supply/metrics.js";
import { isTestFilePath } from "../supply/gates/types.js";
import type { AnchorId, Verdict } from "../types.js";
import {
  buildReview,
  type ReviewDomainCoupling,
  type ReviewDup,
  type ReviewLocation,
  type ReviewViolation,
} from "./build.js";
import { buildDomainReview, type BoundaryDriftFinding, type DomainOverlap } from "./domain-review.js";
import { buildDualLayerReview, type DualLayerGateMode, type DualLayerReview } from "./dual-layer-gate.js";

export interface PrTargetDomain {
  name: string;
  changedAnchors: AnchorId[];
}

export interface PrComplexitySummary {
  functions: number;
  averageCyclomatic: number;
  maximumCyclomatic: number;
  /**
   * 0..100 maintainability-oriented score derived from average cyclomatic
   * complexity. 100 means every function has cyclomatic=1.
   */
  score: number;
}

export interface PrDiffReview {
  temporary: true;
  generatedAt: string;
  diff: BranchDiff;
  domain: {
    hasTargetDomain: boolean;
    targetDomains: PrTargetDomain[];
    unassignedAnchors: AnchorId[];
    /** New structural program-domain gate; legacy fields above remain during migration. */
    dualLayer: DualLayerReview["program"];
  };
  quality: {
    complexity: PrComplexitySummary;
    changedFunctions: NodeMetrics[];
    changedOrphans: ReviewLocation[];
  };
  architecture: {
    verify: Verdict | null;
    changedViolations: ReviewViolation[];
    changedCycles: ReviewLocation[][];
    changedStructuralDuplication: ReviewDup[];
    crossDomainCoupling: ReviewDomainCoupling[];
    changedDomainOverlap: DomainOverlap[];
    changedBoundaryDrift: BoundaryDriftFinding[];
    isolatedChangedAnchors: AnchorId[];
  };
  spec: {
    changedFilesWithoutSpec: string[];
    /** New semantic business-domain gate; legacy field above remains during migration. */
    dualLayer: DualLayerReview["business"];
  };
}

export interface PrDiffReviewOptions {
  base?: string;
  dualLayerMode?: DualLayerGateMode;
}

export function summarizeComplexity(metrics: NodeMetrics[]): PrComplexitySummary {
  if (metrics.length === 0) {
    return { functions: 0, averageCyclomatic: 0, maximumCyclomatic: 0, score: 100 };
  }
  // Single pass, no spread: `Math.max(...)` over a whole-repo metric array
  // throws RangeError once the graph exceeds the engine's argument limit.
  let total = 0;
  let maximum = 0;
  for (const metric of metrics) {
    total += metric.cyclomatic;
    if (metric.cyclomatic > maximum) maximum = metric.cyclomatic;
  }
  const average = total / metrics.length;
  // Smooth, deterministic and monotonic: avg=1 -> 100, avg=5 -> 50.
  const score = Math.max(0, Math.min(100, Math.round(100 / (1 + Math.max(0, average - 1) / 4))));
  return {
    functions: metrics.length,
    averageCyclomatic: Number(average.toFixed(3)),
    maximumCyclomatic: maximum,
    score,
  };
}

export async function buildPrDiffReview(
  ctx: AnalysisContext,
  options: PrDiffReviewOptions = {},
): Promise<PrDiffReview> {
  const diff = await computeBranchDiff(ctx, { base: options.base });
  const changedAnchors = new Set(diff.anchors.all as AnchorId[]);
  const membership = new Map(
    (ctx.domains ?? []).map((domain) => [domain.domain, domain.implementors]),
  );
  const metrics = await computeMetrics(ctx.graph, membership);
  const review = await buildReview(ctx, { maxList: Number.MAX_SAFE_INTEGER });
  const domainReview = await buildDomainReview(ctx, { maxList: Number.MAX_SAFE_INTEGER });

  const targetDomains = (ctx.domains ?? [])
    .map((domain) => ({
      name: domain.domain,
      changedAnchors: domain.implementors.filter((anchor) => changedAnchors.has(anchor)).sort(),
    }))
    .filter((domain) => domain.changedAnchors.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  const assigned = new Set(targetDomains.flatMap((domain) => domain.changedAnchors));
  const changedFiles = new Set(diff.files.map((file) => file.path));
  const changedPaths = diff.available && diff.mergeBase
    ? await changedBranchPaths(ctx.repoPath, diff.mergeBase)
    : [];
  const operatorDomainsDir = process.env["ANATOMIA_PLUGIN_DIR"];
  const businessDomainsDir = operatorDomainsDir
    ?? resolveCommittedOntologyDir(ctx.repoPath)
    ?? domainsDir(ctx.repoPath);
  const dualLayer = await buildDualLayerReview({
    repoPath: ctx.repoPath,
    sourceRevision: diff.head ?? "worktree",
    functions: ctx.functions,
    changedAnchors,
    businessOwnedAnchors: assigned,
    changedPaths,
    specClauses: ctx.specClauses ?? [],
    businessDomains: await loadEditableDomains(businessDomainsDir, {
      skipInvalid: operatorDomainsDir === undefined,
    }),
    mode: options.dualLayerMode ?? "advisory",
  });
  const rawDiff = diff.available && diff.mergeBase && diff.files.length > 0
    ? await branchDiffText(ctx.repoPath, diff.mergeBase, diff.files.map((file) => file.path))
    : null;
  const verify = rawDiff?.trim()
    ? await buildVerdict(ctx, rawDiff)
    : null;
  const isolatedChangedAnchors = domainReview.domains
    .flatMap((domain) => domain.isolated)
    .map((location) => location.anchor)
    .filter((anchor) => changedAnchors.has(anchor));
  // Same production/test boundary the spec_linkage / coupling_delta gates draw
  // (isTestFilePath in supply/gates/types.ts) — kept as one predicate so the
  // two cannot drift apart.
  const isProductionLocation = (location: ReviewLocation): boolean =>
    location.name !== "<anonymous>" && !isTestFilePath(location.file);

  return {
    temporary: true,
    generatedAt: new Date().toISOString(),
    diff,
    domain: {
      hasTargetDomain: targetDomains.length > 0,
      targetDomains,
      unassignedAnchors: [...changedAnchors].filter((anchor) => !assigned.has(anchor)).sort(),
      dualLayer: dualLayer.program,
    },
    quality: {
      complexity: summarizeComplexity(metrics),
      changedFunctions: metrics.filter((metric) => changedAnchors.has(metric.anchor)),
      changedOrphans: review.orphans.filter((orphan) =>
        changedAnchors.has(orphan.anchor) && isProductionLocation(orphan)),
    },
    architecture: {
      verify,
      changedViolations: review.violations.filter((violation) =>
        violation.locations.some((location) => changedAnchors.has(location.anchor))),
      changedCycles: review.cycles.filter((cycle) =>
        cycle.some((location) => changedAnchors.has(location.anchor))),
      changedStructuralDuplication: review.structuralDup.filter((duplication) =>
        duplication.copies.some((location) => changedAnchors.has(location.anchor))),
      crossDomainCoupling: review.domainCoupling,
      changedDomainOverlap: domainReview.overlap.filter((overlap) =>
        changedAnchors.has(overlap.anchor)),
      changedBoundaryDrift: domainReview.boundaryDrift.filter((drift) =>
        changedAnchors.has(drift.anchor)),
      isolatedChangedAnchors: [...new Set(isolatedChangedAnchors)].sort(),
    },
    spec: {
      changedFilesWithoutSpec: review.specGaps.filter((file) => changedFiles.has(file)),
      dualLayer: dualLayer.business,
    },
  };
}
