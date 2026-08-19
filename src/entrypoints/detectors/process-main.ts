/**
 * src/entrypoints/detectors/process-main.ts — Process start (`class: process`).
 *
 * Two signals: a function literally named `main` (C++/C#/Go-shaped programs and
 * TS mains alike), and the top-level invocation inside a file that package.json
 * points at (`bin`, `main`) or that lives under `bin/`. The second is what makes
 * a node CLI's real root visible: `bin/anatomia.mjs` calls `main()` at module
 * top level, and that call — not the file — is the entry.
 *
 * SRP: process entry detection only.
 */

import type { EntryPointSeed } from "../types.js";
import type { Detector, DetectorInput, PackageManifest } from "./types.js";
import { conventionSources, seedForName } from "./scan.js";

/** A statement at column 0 that calls a bare identifier: `main()`, `await run()`. */
const TOP_LEVEL_CALL = /^(?:await[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*\(/gm;

function normalizeRel(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Files package.json nominates as process entries, plus the `bin/` convention. */
export function processEntryFiles(manifest: PackageManifest | undefined, paths: readonly string[]): Set<string> {
  const declared = new Set<string>();
  if (manifest?.main) declared.add(normalizeRel(manifest.main));
  if (typeof manifest?.bin === "string") declared.add(normalizeRel(manifest.bin));
  else if (manifest?.bin) for (const target of Object.values(manifest.bin)) declared.add(normalizeRel(target));
  for (const script of Object.values(manifest?.scripts ?? {})) {
    for (const match of script.matchAll(/(?:^|\s)((?:\.\/)?[\w./-]+\.[cm]?[jt]s)(?:\s|$)/g)) {
      if (match[1]) declared.add(normalizeRel(match[1]));
    }
  }
  for (const path of paths) if (/^bin\/[^/]+\.[cm]?[jt]s$/.test(path)) declared.add(path);
  return declared;
}

/** Statement keywords that also read as `name(` at column 0. */
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "with", "do"]);

export const detectProcessMain: Detector = (input) => {
  const seeds: EntryPointSeed[] = [];
  for (const symbol of input.symbols.conventionScope(input.config.includeTests)) {
    if (symbol.name !== "main") continue;
    seeds.push({
      anchor: symbol.anchor,
      entryClass: "process",
      detector: "process-main",
      reason: `main() in ${symbol.path}`,
    });
  }
  const entryFiles = processEntryFiles(input.packageManifest, [...input.sources.keys()]);
  for (const [path, text] of conventionSources(input)) {
    if (!entryFiles.has(path)) continue;
    for (const match of text.matchAll(TOP_LEVEL_CALL)) {
      const name = match[1];
      if (!name || KEYWORDS.has(name)) continue;
      const seed = seedForName(input, path, name, "process", "process-main",
        `top-level ${name}() in process entry ${path}`);
      if (seed) seeds.push(seed);
    }
  }
  return seeds;
};
