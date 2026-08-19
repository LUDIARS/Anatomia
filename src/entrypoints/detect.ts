/**
 * src/entrypoints/detect.ts — Entry detection: seeds → canonical manifest.
 *
 * Runs every detector over one shared read of the sources, folds the seeds by
 * symbol (a screen that is also a MonoBehaviour lifecycle callback is ONE entry
 * carrying both classes), applies the config's `exclude`, and sorts everything.
 * The result is code-authoritative: it is replaced whole on each sync and has no
 * manual override channel — corrections belong in the config, an annotation, or
 * the source.
 *
 * SRP: orchestration + folding. Heuristics live in detectors/, config in config.ts.
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AnalysisContext } from "../core.js";
import { detectScreens } from "../screens/index.js";
import type { ScreenGraph } from "../screens/types.js";
import type { EntryPoint, EntryPointConfig, EntryPointDiagnostic, EntryPointManifest, EntryPointSeed } from "./types.js";
import { loadEntryPointConfig, ruleMatches } from "./config.js";
import { SymbolIndex } from "./symbols.js";
import { DETECTORS, type DetectorInput, type PackageManifest } from "./detectors/index.js";

export interface DetectEntryPointsOptions {
  /** Pre-detected screens (the caller usually already has them). */
  screens?: ScreenGraph;
  /** Pre-loaded config; when absent it is read from `.anatomia/entrypoints.json`. */
  config?: EntryPointConfig;
}

async function readSources(ctx: AnalysisContext): Promise<Map<string, string>> {
  const entries = await Promise.all(ctx.files.map(async (file) => [
    relative(ctx.repoPath, file.path).replace(/\\/g, "/"),
    await readFile(file.path, "utf8").catch(() => ""),
  ] as const));
  return new Map(entries.sort((left, right) => left[0].localeCompare(right[0])));
}

async function readPackageManifest(repoPath: string): Promise<PackageManifest | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(repoPath, "package.json"), "utf8")) as PackageManifest;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Fold seeds into one entry per symbol; every list sorted and de-duplicated. */
export function foldSeeds(seeds: readonly EntryPointSeed[], index: SymbolIndex): EntryPoint[] {
  const byAnchor = new Map<string, EntryPointSeed[]>();
  for (const seed of seeds) {
    const key = String(seed.anchor);
    (byAnchor.get(key) ?? byAnchor.set(key, []).get(key)!).push(seed);
  }
  const entries: EntryPoint[] = [];
  for (const [anchor, group] of [...byAnchor.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const symbol = index.get(anchor);
    if (!symbol) continue;
    const phases = [...new Set(group.map((seed) => seed.phase).filter((phase): phase is string => !!phase))].sort();
    entries.push({
      id: anchor,
      classes: [...new Set(group.map((seed) => seed.entryClass))].sort(),
      detector: [...new Set(group.map((seed) => seed.detector))].sort(),
      symbol: { anchor: symbol.anchor, name: symbol.name, path: symbol.path, line: symbol.line },
      ...(phases.length > 0 ? { phase: phases[0] } : {}),
      reasons: [...new Set(group.map((seed) => seed.reason))].sort(),
    });
  }
  return entries;
}

/**
 * Detect the entry points of an analyzed repository. Deterministic: identical
 * sources + config produce an identical manifest.
 */
export async function detectEntryPoints(
  ctx: AnalysisContext,
  options: DetectEntryPointsOptions = {},
): Promise<EntryPointManifest> {
  const diagnostics: EntryPointDiagnostic[] = [];
  let config = options.config;
  if (!config) {
    const loaded = await loadEntryPointConfig(ctx.repoPath);
    config = loaded.config;
    diagnostics.push(...loaded.diagnostics);
  }

  const packageManifest = await readPackageManifest(ctx.repoPath);
  const input: DetectorInput = {
    repoPath: ctx.repoPath,
    config,
    symbols: new SymbolIndex(ctx.repoPath, ctx.functions),
    sources: await readSources(ctx),
    files: ctx.files,
    ...(ctx.projectProfile ? { projectProfile: ctx.projectProfile } : {}),
    screens: options.screens ?? await detectScreens(ctx),
    ...(packageManifest ? { packageManifest } : {}),
  };

  return buildEntryPointManifest(input, diagnostics);
}

/**
 * The pure half: run the detectors over already-read inputs and fold. Hermetic,
 * so detection is tested from literal fixtures with no filesystem.
 */
export function buildEntryPointManifest(
  input: DetectorInput,
  priorDiagnostics: readonly EntryPointDiagnostic[] = [],
): EntryPointManifest {
  const diagnostics: EntryPointDiagnostic[] = [...priorDiagnostics];
  const seeds = DETECTORS.flatMap((detector) => detector(input));
  const excluded = (entry: EntryPoint): boolean =>
    input.config.exclude.some((rule) => ruleMatches(rule, {
      anchor: String(entry.symbol.anchor), name: entry.symbol.name, path: entry.symbol.path,
    }));
  const entries = foldSeeds(seeds, input.symbols).filter((entry) => !excluded(entry));

  if (entries.length === 0) {
    diagnostics.push({ kind: "no-entry-detected", message: "no entry point detected (conventions and config both empty)" });
  }
  return {
    entries,
    diagnostics: diagnostics.sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.message.localeCompare(right.message)),
    config: input.config,
  };
}
