/**
 * src/entrypoints/detectors/screen.ts — Screens as entries (`class: screen`).
 *
 * Reuses the detected screen composition (screens/detect.ts) so the screen entry
 * set is the SAME set scene derivation walks — the entry graph and the scene
 * layer must agree about where a screen begins. The entry set for a screen is
 * the function that shares its name when the file declares one (the render
 * function), else every function declared in the screen's file.
 *
 * SRP: screen entry detection only.
 */

import type { EntryPointSeed } from "../types.js";
import type { Detector } from "./types.js";
import { isTestPath } from "../config.js";

export const detectScreen: Detector = (input) => {
  const seeds: EntryPointSeed[] = [];
  const screens = [...input.screens.screens].sort((left, right) => left.name.localeCompare(right.name));
  for (const screen of screens) {
    if (!screen.file) continue;
    if (!input.config.includeTests && isTestPath(screen.file)) continue;
    const declared = input.symbols.inFile(screen.file);
    const named = declared.filter((symbol) => symbol.name === screen.name);
    for (const symbol of named.length > 0 ? named : declared) {
      seeds.push({
        anchor: symbol.anchor,
        entryClass: "screen",
        detector: "screen",
        reason: `screen ${screen.name} (${screen.kind}/${screen.stack}) in ${screen.file}`,
      });
    }
  }
  return seeds;
};
