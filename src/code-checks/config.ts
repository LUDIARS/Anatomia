/**
 * @spec C++ code-level static checks
 *
 * src/code-checks/config.ts — thresholds and rule switches for the C++ checks.
 *
 * Defaults follow the references named in spec/feature/code-checks.md
 * (SonarSource cognitive complexity 15, lizard CCN 15 / length 1000 tokens
 * reduced to lines, clang-tidy readability-function-size parameter 6).
 * A project overrides them in `.anatomia/code-checks.json`. A file that exists
 * but is malformed is an error — it never falls back to defaults silently.
 *
 * SRP: default values, validation and merging of the configuration.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeCheckConfig, CodeCheckThresholds, Severity } from "./types.js";

export const CODE_CHECK_CONFIG_PATH = ".anatomia/code-checks.json";

export const DEFAULT_THRESHOLDS: CodeCheckThresholds = {
  // Single letters only by default: two-letter names (`p0`, `uv`, `dt`) are the
  // notation of the maths they implement often enough that flagging them is noise.
  shortIdentifierMaxLength: 1,
  shortIdentifierAllow: ["i", "j", "k", "n", "x", "y", "z", "w", "u", "v", "t", "r", "g", "b", "a", "_"],
  functionMacrosPerFile: 3,
  maxLineLength: 120,
  statementsPerLine: 1,
  declarationDistance: 15,
  cognitiveComplexity: 15,
  cyclomaticComplexity: 15,
  functionLength: 80,
  parameterCount: 6,
  commentRequiredComplexity: 8,
};

export const DEFAULT_CONFIG: CodeCheckConfig = {
  thresholds: DEFAULT_THRESHOLDS,
  disabledRules: [],
  severity: {},
};

const SEVERITIES = new Set<Severity>(["error", "warning", "info"]);
const NUMERIC_KEYS = (Object.keys(DEFAULT_THRESHOLDS) as (keyof CodeCheckThresholds)[]).filter(
  (key) => typeof DEFAULT_THRESHOLDS[key] === "number",
);

function fail(message: string): never {
  throw new Error(`${CODE_CHECK_CONFIG_PATH}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`${field} must be an array of strings`);
  }
  return value as string[];
}

function thresholds(value: unknown): CodeCheckThresholds {
  if (value === undefined) return DEFAULT_THRESHOLDS;
  if (!isRecord(value)) fail("thresholds must be an object");
  const merged: Record<string, unknown> = { ...DEFAULT_THRESHOLDS };
  for (const [key, raw] of Object.entries(value)) {
    if (!(key in DEFAULT_THRESHOLDS)) fail(`unknown threshold '${key}'`);
    if (key === "shortIdentifierAllow") {
      merged[key] = stringArray(raw, "thresholds.shortIdentifierAllow");
      continue;
    }
    if (!NUMERIC_KEYS.includes(key as keyof CodeCheckThresholds) || !Number.isInteger(raw) || (raw as number) < 0) {
      fail(`threshold '${key}' must be a non-negative integer`);
    }
    merged[key] = raw;
  }
  return merged as unknown as CodeCheckThresholds;
}

function severity(value: unknown): Record<string, Severity> {
  if (value === undefined) return {};
  if (!isRecord(value)) fail("severity must be an object of rule id -> error|warning|info");
  for (const [rule, level] of Object.entries(value)) {
    if (!SEVERITIES.has(level as Severity)) fail(`severity for '${rule}' must be error, warning or info`);
  }
  return value as Record<string, Severity>;
}

/** Validate a parsed configuration document against the known rule ids. */
export function parseCodeCheckConfig(json: unknown, knownRules: ReadonlySet<string>): CodeCheckConfig {
  if (!isRecord(json)) fail("must be a JSON object");
  for (const key of Object.keys(json)) {
    if (key !== "thresholds" && key !== "disabledRules" && key !== "severity") fail(`unknown field '${key}'`);
  }
  const disabledRules = json.disabledRules === undefined ? [] : stringArray(json.disabledRules, "disabledRules");
  const overrides = severity(json.severity);
  for (const rule of [...disabledRules, ...Object.keys(overrides)]) {
    if (!knownRules.has(rule)) fail(`unknown rule '${rule}'`);
  }
  return { thresholds: thresholds(json.thresholds), disabledRules, severity: overrides };
}

/** The project's configuration, or the defaults when the project has none. */
export function loadCodeCheckConfig(repoRoot: string, knownRules: ReadonlySet<string>): CodeCheckConfig {
  let text: string;
  try {
    text = readFileSync(join(repoRoot, CODE_CHECK_CONFIG_PATH), "utf8");
  } catch (error) {
    // Absence is the documented "use defaults" case; any other read failure is not.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON (${(error as Error).message})`);
  }
  return parseCodeCheckConfig(json, knownRules);
}
