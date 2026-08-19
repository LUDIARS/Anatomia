/**
 * src/entrypoints/detectors/explicit.ts — Operator-declared entry points.
 *
 * Two ways to say "this is an entry" without teaching Anatomia a new convention:
 * `.anatomia/entrypoints.json` (repository config) and an `@anatomia-entry`
 * comment directly above the definition. Both outrank convention detection and
 * both are allowed to name a symbol in a test file — an explicit declaration is
 * a statement of intent, so `includeTests` (which gates CONVENTION detection)
 * does not filter it.
 *
 * SRP: the two explicit detectors only.
 */

import type { EntryClass, EntryPointSeed } from "../types.js";
import { ruleMatches } from "../config.js";
import type { Detector } from "./types.js";

const ANNOTATION = /@anatomia-entry(?:[ \t]+([a-z-]+))?/;

const ENTRY_CLASSES: readonly EntryClass[] = [
  "process", "http-route", "cli-command", "event-handler",
  "scheduled", "framework-lifecycle", "screen", "explicit",
];

/** `include` rules from `.anatomia/entrypoints.json`. */
export const detectExplicitConfig: Detector = (input) => {
  const seeds: EntryPointSeed[] = [];
  for (const rule of input.config.include) {
    for (const symbol of input.symbols.all) {
      if (!ruleMatches(rule, { anchor: String(symbol.anchor), name: symbol.name, path: symbol.path })) continue;
      seeds.push({
        anchor: symbol.anchor,
        entryClass: rule.class ?? "explicit",
        detector: "explicit-config",
        reason: `.anatomia/entrypoints.json include ${rule.symbol ?? rule.pathGlob ?? rule.namePattern ?? ""}`,
      });
    }
  }
  return seeds;
};

/**
 * `@anatomia-entry [class]` in a comment above the definition. The annotation is
 * searched in the 5 lines preceding the declaration so a doc comment between the
 * marker and the signature does not break it.
 */
export const detectExplicitAnnotation: Detector = (input) => {
  const seeds: EntryPointSeed[] = [];
  const linesByPath = new Map<string, string[]>();
  for (const symbol of input.symbols.all) {
    const text = input.sources.get(symbol.path);
    if (text === undefined) continue;
    let lines = linesByPath.get(symbol.path);
    if (!lines) linesByPath.set(symbol.path, (lines = text.split(/\r?\n/)));
    // Walk only the contiguous comment/blank block above the declaration. A
    // fixed slice alone lets one function's annotation leak onto the next
    // nearby declaration.
    const precedingLines: string[] = [];
    for (let line = symbol.line - 1; line >= Math.max(0, symbol.line - 5); line -= 1) {
      const candidate = lines[line]?.trim() ?? "";
      if (candidate !== ""
        && !candidate.startsWith("//")
        && !candidate.startsWith("/*")
        && !candidate.startsWith("*")
        && candidate !== "*/") break;
      precedingLines.unshift(candidate);
    }
    const preceding = precedingLines.join("\n");
    const match = ANNOTATION.exec(preceding);
    if (!match) continue;
    const declared = match[1] as EntryClass | undefined;
    seeds.push({
      anchor: symbol.anchor,
      entryClass: declared && ENTRY_CLASSES.includes(declared) ? declared : "explicit",
      detector: "explicit-annotation",
      reason: `@anatomia-entry above ${symbol.path}:${symbol.line}`,
    });
  }
  return seeds;
};
