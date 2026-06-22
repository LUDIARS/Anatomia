/**
 * src/domains/view-modules.ts — Per-domain 機能(module) breakdown for the panel.
 *
 * The Domain View's right pane lists, for a selected domain, the modules its
 * implementor functions span — each with its cohesion and member count. This is
 * the "input narrowed to a domain → list its module group" view: a domain is
 * usually a handful of cohesive modules, so the module list is the natural,
 * scannable index into the domain (finer than "one big graph", coarser than
 * "every function").
 *
 * SRP: shape (domains × module index) → per-domain module refs. No graph access,
 * no HTTP — the module evaluation is computed once at analyze time and passed in.
 */

import type { AnchorId } from "../types.js";
import type { DetectionResult } from "./detect.js";
import type { ModuleEvaluation } from "../modules/types.js";

/** One module a domain spans, with its cohesion + how many of its members the domain owns. */
export interface DomainModuleRef {
  moduleId: string;
  label: string;
  /** Cohesion 0..1 of the whole module (not just the domain's slice). */
  cohesion: number | null;
  /** #implementor anchors of this domain that live in this module. */
  domainAnchors: number;
  /** #anchors in the whole module (domain may own only a slice). */
  moduleAnchors: number;
}

/**
 * Build domain → module-refs. For each domain, group its implementor anchors by
 * module and attach the module's cohesion. Sorted by the domain's share desc.
 */
export function buildDomainModules(
  domains: DetectionResult[],
  evaluation: ModuleEvaluation,
): Record<string, DomainModuleRef[]> {
  // anchor → moduleId, moduleId → (label, cohesion, size).
  const moduleOf = new Map<AnchorId, string>();
  const label = new Map<string, string>();
  const size = new Map<string, number>();
  for (const m of evaluation.modules) {
    label.set(m.id, m.label);
    size.set(m.id, m.anchors.length);
    for (const a of m.anchors) moduleOf.set(a, m.id);
  }
  const cohesion = new Map<string, number>();
  for (const c of evaluation.cohesion) cohesion.set(c.moduleId, c.cohesion);

  const out: Record<string, DomainModuleRef[]> = {};
  for (const d of domains) {
    if (d.implementors.length === 0) continue;
    const counts = new Map<string, number>();
    for (const a of d.implementors) {
      const mid = moduleOf.get(a);
      if (mid !== undefined) counts.set(mid, (counts.get(mid) ?? 0) + 1);
    }
    const refs: DomainModuleRef[] = [...counts.entries()]
      .map(([mid, n]) => ({
        moduleId: mid,
        label: label.get(mid) ?? mid,
        cohesion: cohesion.has(mid) ? cohesion.get(mid)! : null,
        domainAnchors: n,
        moduleAnchors: size.get(mid) ?? n,
      }))
      .sort((a, b) =>
        b.domainAnchors !== a.domainAnchors
          ? b.domainAnchors - a.domainAnchors
          : a.moduleId < b.moduleId
            ? -1
            : 1,
      );
    out[d.domain] = refs;
  }
  return out;
}
