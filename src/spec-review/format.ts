/**
 * Human-readable formatting for the AIFormat-backed spec review report.
 */

import type { SpecReviewReport } from "./review.js";

export function formatSpecReview(report: SpecReviewReport): string {
  const out: string[] = [];
  out.push(`Spec review of ${report.project}`);
  out.push(
    `  grade=${report.grade} findings=${report.summary.findings} ` +
      `critical=${report.summary.critical} high=${report.summary.high} ` +
      `medium=${report.summary.medium} low=${report.summary.low}`,
  );
  out.push(`  criteria=AIFormat (${report.criteria.files.join(", ") || "not found"})`);
  out.push(
    `  categories=${report.summary.presentCategories.join(", ") || "-"} ` +
      `missing=${report.summary.missingCategories.join(", ") || "-"} ` +
      `empty=${report.summary.emptyCategories.join(", ") || "-"}`,
  );

  if (report.findings.length) {
    out.push("\n# Findings");
    for (const finding of report.findings) {
      out.push(`  [${finding.severity}] ${finding.kind} ${finding.path}`);
      out.push(`      ${finding.message}`);
      out.push(`      fix: ${finding.suggestion}`);
      out.push(`      criterion: ${finding.criterion}`);
    }
  }

  return out.join("\n");
}
