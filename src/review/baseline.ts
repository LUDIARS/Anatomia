/**
 * src/review/baseline.ts — Review baseline: fingerprint + filter known findings.
 *
 * A baseline file records the fingerprints of findings that have been
 * acknowledged (accepted as known / won't-fix). When a baseline is active,
 * `applyBaseline` removes acknowledged entries from the report so only NEW
 * findings surface — useful in CI and iterative review workflows.
 *
 * File format (JSON, human-editable):
 * {
 *   "violations":    ["<rule>\0<evidence>", ...],
 *   "structuralDup": ["<anchorHash>", ...],
 *   "cycles":        ["<file:line,...>", ...],
 *   "domainCoupling":["<from>→<to>", ...]
 * }
 *
 * SRP: fingerprinting + set-based filtering only. No analysis, no I/O beyond
 * the two load/save helpers.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { ReviewReport, ReviewViolation, ReviewDup, ReviewDomainCoupling, ReviewLocation } from "./build.js";

export interface ReviewBaseline {
  violations: Set<string>;
  structuralDup: Set<string>;
  cycles: Set<string>;
  domainCoupling: Set<string>;
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

export function fingerprintViolation(v: ReviewViolation): string {
  return `${v.rule}\0${v.evidence}`;
}

export function fingerprintDup(d: ReviewDup): string {
  return d.anchor;
}

export function fingerprintCycle(cycle: ReviewLocation[]): string {
  return cycle.map((l) => `${l.file}:${l.line}`).join(",");
}

export function fingerprintCoupling(c: ReviewDomainCoupling): string {
  return `${c.from}→${c.to}`;
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

interface BaselineFile {
  violations?: string[];
  structuralDup?: string[];
  cycles?: string[];
  domainCoupling?: string[];
}

export async function loadBaseline(path: string): Promise<ReviewBaseline> {
  let raw: BaselineFile;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as BaselineFile;
  } catch {
    return { violations: new Set(), structuralDup: new Set(), cycles: new Set(), domainCoupling: new Set() };
  }
  return {
    violations: new Set(raw.violations ?? []),
    structuralDup: new Set(raw.structuralDup ?? []),
    cycles: new Set(raw.cycles ?? []),
    domainCoupling: new Set(raw.domainCoupling ?? []),
  };
}

/** Write the current report's fingerprints as a new baseline file. */
export async function saveBaseline(path: string, report: ReviewReport): Promise<void> {
  const file: BaselineFile = {
    violations: report.violations.map(fingerprintViolation),
    structuralDup: report.structuralDup.map(fingerprintDup),
    cycles: report.cycles.map(fingerprintCycle),
    domainCoupling: report.domainCoupling.map(fingerprintCoupling),
  };
  await writeFile(path, JSON.stringify(file, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Return a copy of `report` with all baseline-acknowledged findings removed.
 * Summary counts are recalculated to match the filtered arrays.
 */
export function applyBaseline(report: ReviewReport, baseline: ReviewBaseline): ReviewReport {
  const violations = report.violations.filter((v) => !baseline.violations.has(fingerprintViolation(v)));
  const structuralDup = report.structuralDup.filter((d) => !baseline.structuralDup.has(fingerprintDup(d)));
  const cycles = report.cycles.filter((c) => !baseline.cycles.has(fingerprintCycle(c)));
  const domainCoupling = report.domainCoupling.filter((c) => !baseline.domainCoupling.has(fingerprintCoupling(c)));
  return {
    ...report,
    violations,
    structuralDup,
    cycles,
    domainCoupling,
    summary: {
      ...report.summary,
      violations: violations.length,
      structuralDup: structuralDup.length,
      cycles: cycles.length,
      domainCoupling: domainCoupling.length,
    },
  };
}
