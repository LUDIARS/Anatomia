/**
 * src/entrypoints/detectors/framework-lifecycle.ts — Engine lifecycle callbacks
 * (`class: framework-lifecycle`).
 *
 * Reuses the existing Unity recognizer (frameworks/unity/lifecycle.ts) rather
 * than re-deriving MonoBehaviour rules: it already checks the documented
 * signature AND that the declaring type actually derives from MonoBehaviour, so
 * a plain class with an `Update()` method is not mistaken for an engine entry.
 * The lifecycle phase rides along on the seed.
 *
 * SRP: framework lifecycle entry detection only.
 */

import { resolveUnityLifecycleFunctions } from "../../frameworks/unity/lifecycle.js";
import type { FunctionNode } from "../../types.js";
import type { EntryPointSeed } from "../types.js";
import type { Detector } from "./types.js";
import { isTestPath } from "../config.js";

export const detectFrameworkLifecycle: Detector = (input) => {
  // The recognizer needs FunctionNodes; the symbol index carries the anchors it
  // returns, so rebuild the minimum shape from the analyzed file set.
  const functions: FunctionNode[] = input.files.flatMap((file) => file.functions ?? []);
  const matches = resolveUnityLifecycleFunctions({
    ...(input.projectProfile ? { projectProfile: input.projectProfile } : {}),
    files: input.files,
    functions,
  });
  const seeds: EntryPointSeed[] = [];
  for (const match of [...matches.values()].sort((left, right) => String(left.anchor).localeCompare(String(right.anchor)))) {
    const symbol = input.symbols.get(String(match.anchor));
    if (!symbol) continue;
    if (!input.config.includeTests && isTestPath(symbol.path)) continue;
    seeds.push({
      anchor: match.anchor,
      entryClass: "framework-lifecycle",
      detector: "framework-lifecycle",
      reason: `Unity ${match.event} on ${match.ownerType}`,
      phase: match.phase,
    });
  }
  return seeds;
};
