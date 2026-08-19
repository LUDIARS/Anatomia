/**
 * src/entrypoints/detectors/scan.ts — Shared source-scan plumbing for the
 * convention detectors.
 *
 * Every convention detector does the same three things: restrict itself to the
 * files `includeTests` allows, run a regex over the text, and turn a captured
 * handler name into an anchor. Keeping that here means a detector file contains
 * only its heuristic.
 *
 * SRP: iteration + name→seed plumbing. No heuristics of its own.
 */

import type { EntryClass, EntryDetectorName, EntryPointSeed } from "../types.js";
import { isTestPath } from "../config.js";
import type { DetectorInput } from "./types.js";

/** Source files the convention detectors are allowed to look at, path-sorted. */
export function conventionSources(input: DetectorInput): [string, string][] {
  return [...input.sources.entries()]
    .filter(([path]) => input.config.includeTests || !isTestPath(path))
    .sort((left, right) => left[0].localeCompare(right[0]));
}

/** TypeScript/JavaScript sources only (the JS-family detectors' scope). */
export function isJsFamily(path: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(path);
}

/**
 * Resolve a handler name found in `path` and emit a seed. Unresolvable or
 * ambiguous names are dropped: a detector that guesses would root a whole
 * subtree at the wrong symbol.
 */
export function seedForName(
  input: DetectorInput,
  path: string,
  name: string,
  entryClass: EntryClass,
  detector: EntryDetectorName,
  reason: string,
): EntryPointSeed | null {
  const symbol = input.symbols.resolve(name, path);
  if (!symbol) return null;
  if (!input.config.includeTests && isTestPath(symbol.path)) return null;
  return { anchor: symbol.anchor, entryClass, detector, reason };
}

/** Every capture-group value of a global regex over `text`, in order. */
export function captures(text: string, pattern: RegExp): RegExpMatchArray[] {
  return [...text.matchAll(pattern)];
}
