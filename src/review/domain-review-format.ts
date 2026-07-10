/**
 * Human-readable rendering of a DomainReviewReport for the CLI. Pure string
 * building; the JSON shape (domain-review.ts) is the machine contract, this is
 * the terminal view (mirrors format.ts for the code review).
 */

import type { ReviewLocation } from "./build.js";
import type { DomainReviewReport } from "./domain-review.js";

const loc = (l: ReviewLocation): string => `${l.name} (${l.file}:${l.line})`;

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function formatDomainReview(r: DomainReviewReport): string {
  const out: string[] = [];
  out.push(`Domain review of ${r.project}`);
  const s = r.summary;
  out.push(
    `  domains=${s.domains} functions=${s.functions} assigned=${s.assigned} ` +
      `coverage=${pct(s.coverage)} unassigned=${s.unassigned} overlap=${s.overlap} ` +
      `isolated=${s.isolated} specIntegrity=${s.specIntegrity}`,
  );

  if (r.domains.length) {
    out.push("\n# Domains (cohesion = internal / (internal + boundary) calls edges)");
    for (const d of r.domains) {
      const coh = d.cohesion === null ? "n/a" : pct(d.cohesion);
      out.push(
        `  ${d.domain}  implementors=${d.implementors} internal=${d.internalEdges} ` +
          `boundary=${d.boundaryEdges} cohesion=${coh}${d.conforms ? "" : "  [violations]"}`,
      );
      if (d.isolatedCount > 0) {
        const capped = d.isolated.length < d.isolatedCount ? ` (first ${d.isolated.length}/${d.isolatedCount})` : "";
        out.push(`      isolated members${capped}:`);
        for (const i of d.isolated) out.push(`        - ${loc(i)}`);
      }
    }
  }

  if (r.unassigned.length) {
    const capped = r.unassigned.length < s.unassigned ? ` — first ${r.unassigned.length}/${s.unassigned}` : "";
    out.push(`\n# Unassigned functions (no domain claims them)${capped}`);
    for (const u of r.unassigned) out.push(`  ${loc(u)}`);
  }

  if (r.overlap.length) {
    const capped = r.overlap.length < s.overlap ? ` — first ${r.overlap.length}/${s.overlap}` : "";
    out.push(`\n# Domain overlap (claimed by multiple domains)${capped}`);
    for (const o of r.overlap) {
      out.push(`  ${o.name} (${o.file}:${o.line})  domains: ${o.domains.join(", ")}`);
    }
  }

  if (r.specIntegrity.length) {
    out.push("\n# Spec integrity — specRefs declared but no implementor linked to any clause");
    for (const w of r.specIntegrity) {
      out.push(`  ${w.domain}  (${w.implementors} implementors)  specRefs: ${w.specRefs.join(", ")}`);
    }
  }

  return out.join("\n");
}
