/**
 * @spec C++ code-level static checks
 *
 * src/code-checks/run.ts — run every check family over C++ sources.
 *
 * Pure with respect to the filesystem: callers hand in file text, so tests and
 * the Revisor gate feed exactly the bytes they mean to judge.
 *
 * SRP: parsing each source, dispatching to the families, applying the
 * configured severities and switches, and assembling the report.
 */

import { parse } from "../dag/parser.js";
import { CHECK_FAMILIES, defaultSeverities } from "./families.js";
import type { CheckedSource, CodeCheckConfig, CodeCheckReport, CodeFinding, Severity } from "./types.js";
import { DEFAULT_CONFIG } from "./config.js";
import { walk } from "./syntax.js";

export interface SourceInput {
  readonly file: string;
  readonly text: string;
}

const HEADER_EXTENSIONS = /\.(?:h|hh|hpp|hxx|h\+\+|inl|ipp)$/i;
// Plain C (`.c`) is excluded: malloc/free are its only allocator, not a smell.
export const CPP_EXTENSIONS = /\.(?:cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|inl|ipp)$/i;

function compare(a: CodeFinding, b: CodeFinding): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule);
}

async function prepare(input: SourceInput): Promise<{ source: CheckedSource; hasErrors: boolean; release: () => void }> {
  const tree = await parse(input.text, "cpp");
  const root = tree.rootNode;
  let hasErrors = false;
  for (const node of walk(root)) {
    if (node.type === "ERROR" || node.isMissing) {
      hasErrors = true;
      break;
    }
  }
  return {
    source: {
      file: input.file,
      text: input.text,
      lines: input.text.split(/\r?\n/),
      root,
      isHeader: HEADER_EXTENSIONS.test(input.file),
    },
    hasErrors,
    release: () => tree.delete(),
  };
}

/** Check the given C++ sources and return one report. */
export async function runCodeChecks(
  inputs: readonly SourceInput[],
  config: CodeCheckConfig = DEFAULT_CONFIG,
): Promise<CodeCheckReport> {
  const severities = defaultSeverities();
  const disabled = new Set(config.disabledRules);
  const findings: CodeFinding[] = [];
  const parseErrors: string[] = [];

  for (const input of inputs) {
    const { source, hasErrors, release } = await prepare(input);
    // tree-sitter recovers from errors, so the rest of the file is still judged;
    // the caller is told the findings for this file may be incomplete.
    if (hasErrors) parseErrors.push(input.file);
    try {
      for (const family of CHECK_FAMILIES) {
        for (const raw of family.check(source, config.thresholds)) {
          if (disabled.has(raw.rule)) continue;
          const severity: Severity = config.severity[raw.rule] ?? raw.severity ?? severities.get(raw.rule) ?? "warning";
          findings.push({ ...raw, file: input.file, severity });
        }
      }
    } finally {
      // The tree owns WASM memory; a large sweep would otherwise hold every file's tree.
      release();
    }
  }

  findings.sort(compare);
  const totals: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) totals[finding.severity] += 1;
  return { version: 1, files: inputs.length, findings, totals, parseErrors };
}
