/**
 * @spec C++ code-level static checks
 *
 * src/code-checks/format.ts — human-readable rendering of a code-check report.
 *
 * SRP: text formatting only (the JSON form is the report object itself).
 */

import type { CodeCheckReport } from "./types.js";

export function formatCodeCheckReport(report: CodeCheckReport): string {
  const lines = report.findings.map(
    (f) => `${f.file}:${f.line}:${f.column}: ${f.severity}: ${f.message} [${f.rule}]${f.symbol ? ` (${f.symbol})` : ""}`,
  );
  for (const file of report.parseErrors) lines.push(`${file}: info: syntax not fully parsed; findings may be incomplete [parse]`);
  const { error, warning, info } = report.totals;
  lines.push(`${report.files} file(s): ${error} error(s), ${warning} warning(s), ${info} info`);
  return `${lines.join("\n")}\n`;
}
