/**
 * Human-readable rendering of a ReviewReport for the CLI. Pure string building;
 * the JSON shape (build.ts) is the machine contract, this is the terminal view.
 */

import type { ReviewLocation, ReviewReport } from "./build.js";

const loc = (l: ReviewLocation): string => `${l.name} (${l.file}:${l.line})`;

export function formatReview(r: ReviewReport): string {
  const out: string[] = [];
  out.push(`Review of ${r.project}`);
  const s = r.summary;
  out.push(
    `  violations=${s.violations} hotspots=${s.hotspots} cycles=${s.cycles} ` +
      `dup=${s.structuralDup} domainCoupling=${s.domainCoupling} orphans=${s.orphans} specGaps=${s.specGaps}`,
  );

  if (r.violations.length) {
    out.push("\n# Rule violations");
    for (const v of r.violations) {
      out.push(`  [${v.severity}] ${v.rule}: ${v.evidence}`);
      for (const l of v.locations) out.push(`      @ ${loc(l)}`);
    }
  }

  if (r.hotspots.length) {
    out.push("\n# Coupling hotspots");
    for (const h of r.hotspots) {
      out.push(`  ${loc(h)}  coupling=${h.coupling} fanIn=${h.fanIn} fanOut=${h.fanOut} cyclomatic=${h.cyclomatic}`);
    }
  }

  if (r.cycles.length) {
    out.push("\n# Dependency cycles");
    for (const cyc of r.cycles) out.push(`  ${cyc.map((l) => l.name).join(" -> ")}`);
  }

  if (r.structuralDup.length) {
    out.push("\n# Structural duplicates (identical Anchor ID)");
    for (const d of r.structuralDup) {
      out.push(`  ${d.name} x${d.copies.length}`);
      for (const c of d.copies) out.push(`      @ ${c.file}:${c.line}`);
    }
  }

  if (r.domainCoupling.length) {
    out.push("\n# Cross-domain coupling");
    for (const dc of r.domainCoupling) out.push(`  ${dc.from} -> ${dc.to}  (${dc.edges} edges)`);
  }

  if (r.orphans.length) {
    out.push(`\n# Orphans (no static caller)${r.orphans.length < r.summary.orphans ? ` — first ${r.orphans.length}/${r.summary.orphans}` : ""}`);
    for (const o of r.orphans) out.push(`  ${loc(o)}`);
  }

  if (r.specGaps.length) {
    out.push(`\n# Spec gaps — files with no linked clause${r.specGaps.length < r.summary.specGaps ? ` (first ${r.specGaps.length}/${r.summary.specGaps})` : ""}`);
    for (const g of r.specGaps) out.push(`  ${g}`);
  }

  return out.join("\n");
}
