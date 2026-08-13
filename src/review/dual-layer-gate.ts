/**
 * Two-layer domain gate for ephemeral PR review.
 *
 * Program-domain membership is structural and total; business-domain ownership
 * is semantic and required only for changed specification clauses.
 */

import { basename, relative } from "node:path";
import { deriveProgramDomains, isDependencyArtifactPath, loadProgramDomainConfig } from "../domains/program/index.js";
import type { EditableDomainDef } from "../domains/authoring/index.js";
import { normalizeIdSegment } from "../knowledge/identity.js";
import { buildModules } from "../modules/build.js";
import type { FunctionNode, SpecClause } from "../types.js";

export type DualLayerGateMode = "advisory" | "enforced";

export interface DualLayerGateResult {
  mode: DualLayerGateMode;
  /** The gate would pass once the migration mode becomes enforced. */
  pass: boolean;
  /** Violations always represent a future block, including in advisory mode. */
  wouldBlock: boolean;
  /** True only when the caller elected to enforce the new gate. */
  blocking: boolean;
}

export interface ProgramDomainGate extends DualLayerGateResult {
  unclassifiedAnchors: string[];
  /** Business ownership is intentionally informational for code. */
  businessUnownedAnchors: string[];
}

export interface BusinessDomainGate extends DualLayerGateResult {
  skippedForDependencyOnlyChange: boolean;
  unownedClauses: Array<{ id: string; sourceFile: string; heading: string }>;
  /** Program-domain refinement is intentionally informational for specs. */
  programUnrefinedClauses: Array<{ id: string; sourceFile: string; heading: string }>;
}

export interface DualLayerReview {
  program: ProgramDomainGate;
  business: BusinessDomainGate;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function gate(mode: DualLayerGateMode, violations: number): DualLayerGateResult {
  const wouldBlock = violations > 0;
  return { mode, pass: !wouldBlock, wouldBlock, blocking: mode === "enforced" && wouldBlock };
}

function clauseView(clause: SpecClause): { id: string; sourceFile: string; heading: string } {
  return { id: clause.id, sourceFile: clause.sourceFile, heading: clause.heading };
}

function isClauseOwned(clause: SpecClause, domains: readonly EditableDomainDef[]): boolean {
  return domains.some((domain) => (domain.specRefs ?? []).some((reference) =>
    reference === clause.id || reference === clause.heading || reference === `${clause.sourceFile}:${clause.heading}`,
  ));
}

/**
 * Evaluate the two independent ownership directions from PR-local inputs.
 * `changedPaths` includes non-source artifacts, which is needed to recognize
 * dependency-only updates that produce no function anchors.
 */
export async function buildDualLayerReview(input: {
  repoPath: string;
  sourceRevision: string;
  functions: FunctionNode[];
  changedAnchors: ReadonlySet<string>;
  businessOwnedAnchors: ReadonlySet<string>;
  changedPaths: readonly string[];
  specClauses: readonly SpecClause[];
  businessDomains: readonly EditableDomainDef[];
  mode: DualLayerGateMode;
}): Promise<DualLayerReview> {
  const config = await loadProgramDomainConfig(input.repoPath);
  const modules = buildModules(input.functions);
  const moduleByAnchor = new Map(modules.flatMap((module) => module.anchors.map((anchor) => [String(anchor), module.id])));
  const symbols = input.functions.flatMap((fn) => {
    if (!fn.id) return [];
    const moduleId = moduleByAnchor.get(String(fn.id));
    if (!moduleId) return [];
    return [{ id: String(fn.id), moduleId, path: normalizePath(relative(input.repoPath, fn.sourceRange.filePath)) }];
  });
  const graph = deriveProgramDomains({
    projectId: normalizeIdSegment(basename(input.repoPath), "project"),
    sourceRevision: input.sourceRevision,
    modules,
    symbols,
    config,
  });
  const unclassified = new Set(graph.diagnostics.flatMap((diagnostic) => diagnostic.symbolIds));
  const unclassifiedAnchors = [...input.changedAnchors].filter((anchor) => unclassified.has(anchor)).sort();

  // Existing semantic domain detection remains informational for code; its
  // absence is never a two-layer program-domain violation.
  const businessUnownedAnchors = [...input.changedAnchors]
    .filter((anchor) => !input.businessOwnedAnchors.has(anchor))
    .sort();
  const dependencyOnly = input.changedPaths.length > 0 && input.changedPaths.every(isDependencyArtifactPath);
  const changedPathSet = new Set(input.changedPaths.map(normalizePath));
  const changedClauses = input.specClauses.filter((clause) => changedPathSet.has(normalizePath(clause.sourceFile)));
  const unownedClauses = dependencyOnly ? [] : changedClauses.filter((clause) => !isClauseOwned(clause, input.businessDomains));

  return {
    program: { ...gate(input.mode, unclassifiedAnchors.length), unclassifiedAnchors, businessUnownedAnchors },
    business: {
      ...gate(input.mode, unownedClauses.length),
      skippedForDependencyOnlyChange: dependencyOnly,
      unownedClauses: unownedClauses.map(clauseView).sort((left, right) => left.id.localeCompare(right.id)),
      programUnrefinedClauses: [],
    },
  };
}
