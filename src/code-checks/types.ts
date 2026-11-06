/**
 * @spec C++ code-level static checks
 *
 * src/code-checks/types.ts — shared vocabulary of the C++ code-level checks.
 *
 * Spec: spec/feature/code-checks.md. The checks are static and deterministic:
 * a tree-sitter syntax tree in, findings out. No LLM, no network, no build.
 *
 * SRP: type definitions only.
 */

import type { Node } from "web-tree-sitter";

/** The six check families the specification names. */
export type CheckCategory =
  | "memory"
  | "obfuscation"
  | "placement"
  | "declaration"
  | "complexity"
  | "comment";

export type Severity = "error" | "warning" | "info";

/** Ordered so a numeric comparison answers "at or above the threshold". */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  info: 1,
  warning: 2,
  error: 3,
};

export interface CodeFinding {
  /** Stable rule id, `<category>/<name>`. */
  readonly rule: string;
  readonly category: CheckCategory;
  readonly severity: Severity;
  /** Path as given to the runner (repository-relative when the caller passes one). */
  readonly file: string;
  /** 1-based line. */
  readonly line: number;
  /** 1-based column. */
  readonly column: number;
  readonly message: string;
  /** Function the finding sits in, when there is one. */
  readonly symbol?: string;
  /** The measured value for threshold rules (complexity, distance, length...). */
  readonly value?: number;
  /** The threshold the value was compared against. */
  readonly threshold?: number;
}

/** Thresholds every rule reads. Loaded and validated by config.ts. */
export interface CodeCheckThresholds {
  /** Identifiers at or below this length are "short" (allow-list aside). */
  readonly shortIdentifierMaxLength: number;
  /** Identifiers exempt from the short-name rule (loop counters, coordinates). */
  readonly shortIdentifierAllow: readonly string[];
  /** Function-like macros allowed per file before the file is flagged. */
  readonly functionMacrosPerFile: number;
  /** Physical line length above which a line is "dense". */
  readonly maxLineLength: number;
  /** Statements allowed on one physical line. */
  readonly statementsPerLine: number;
  /** Lines between a local's declaration and its first use. */
  readonly declarationDistance: number;
  readonly cognitiveComplexity: number;
  readonly cyclomaticComplexity: number;
  /** Lines of a function body. */
  readonly functionLength: number;
  readonly parameterCount: number;
  /** Functions at or above this cognitive complexity need an explanatory comment. */
  readonly commentRequiredComplexity: number;
}

export interface CodeCheckConfig {
  readonly thresholds: CodeCheckThresholds;
  /** Rule ids switched off for the project. */
  readonly disabledRules: readonly string[];
  /** Per-rule severity overrides. */
  readonly severity: Readonly<Record<string, Severity>>;
}

/** One parsed file handed to every rule. */
export interface CheckedSource {
  readonly file: string;
  readonly text: string;
  readonly lines: readonly string[];
  readonly root: Node;
  /** True for .h/.hh/.hpp/.hxx — declarations there are the public surface. */
  readonly isHeader: boolean;
}

/** A finding before the runner applies the configured severity and filter. */
export type RawFinding = Omit<CodeFinding, "severity" | "file"> & { readonly severity?: Severity };

/** A rule family: one module, one responsibility, many rule ids. */
export interface CheckFamily {
  readonly category: CheckCategory;
  /** Every rule id this family can emit, with its default severity. */
  readonly rules: Readonly<Record<string, Severity>>;
  check(source: CheckedSource, thresholds: CodeCheckThresholds): RawFinding[];
}

export interface CodeCheckReport {
  readonly version: 1;
  readonly files: number;
  readonly findings: readonly CodeFinding[];
  /** Counts per severity, for a gate that only reads totals. */
  readonly totals: Readonly<Record<Severity, number>>;
  /** Files tree-sitter could not parse cleanly; their findings may be partial. */
  readonly parseErrors: readonly string[];
}
