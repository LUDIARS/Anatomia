/**
 * src/domains/program/diagnose.ts — program-domain classification diagnosis.
 *
 * The one place that turns an analyzed function set into the inputs
 * `deriveProgramDomains` needs (dir modules + repo-relative symbols) and then
 * summarises the outcome per layer / per module. Both the Revisor two-layer
 * gate (review/dual-layer-gate.ts) and the operator-facing CLI
 * (`anatomia domains program`) read the SAME derivation, so an operator who
 * edits `.anatomia/layers.json` until the CLI reports `unclassified: 0` knows
 * the gate will agree.
 *
 * SRP: module/symbol construction + result shaping. Classification rules live
 * in classify.ts, component synthesis in derive.ts, config loading in config.ts.
 */

import { basename, relative } from "node:path";
import { normalizeIdSegment } from "../../knowledge/identity.js";
import { buildModules } from "../../modules/build.js";
import type { ModuleUnit } from "../../modules/types.js";
import type { FunctionNode } from "../../types.js";
import { classifyProgramModules } from "./classify.js";
import { loadProgramDomainConfigWithPresence } from "./config.js";
import { deriveProgramDomains } from "./derive.js";
import type { ClassifiedModule, ProgramDiagnostic, ProgramDomainConfig, ProgramDomainGraph, ProgramSymbol } from "./types.js";

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Directory modules + repo-relative symbols for `deriveProgramDomains`. */
export interface ProgramDomainInputs {
  modules: ModuleUnit[];
  symbols: ProgramSymbol[];
}

/**
 * Build the derivation inputs from analyzed functions. Symbol paths are
 * repo-relative with forward slashes — the form `.anatomia/layers.json` globs
 * are written against.
 */
export function buildProgramDomainInputs(repoPath: string, functions: readonly FunctionNode[]): ProgramDomainInputs {
  const repoRelativeFunctions = functions.map((fn) => ({
    ...fn,
    sourceRange: { ...fn.sourceRange, filePath: normalizePath(relative(repoPath, fn.sourceRange.filePath)) },
  }));
  const modules = buildModules(repoRelativeFunctions);
  const moduleByAnchor = new Map(modules.flatMap((module) => module.anchors.map((anchor) => [String(anchor), module.id])));
  const symbols = functions.flatMap((fn) => {
    if (!fn.id) return [];
    const moduleId = moduleByAnchor.get(String(fn.id));
    if (!moduleId) return [];
    return [{ id: String(fn.id), moduleId, path: normalizePath(relative(repoPath, fn.sourceRange.filePath)) }];
  });
  return { modules, symbols };
}

/** One layer's share of the derived graph. */
export interface ProgramLayerSummary {
  layer: string;
  domainCount: number;
  moduleCount: number;
  symbolCount: number;
}

/** One module's classification outcome, with the evidence an operator needs to write a rule. */
export interface ProgramModuleClassification {
  moduleId: string;
  layer: string | null;
  source: ClassifiedModule["source"];
  symbolCount: number;
  /** Repo-relative files the module spans (glob targets). */
  files: string[];
}

/** An unclassified module: what a `.anatomia/layers.json` rule must still cover. */
export interface ProgramUnclassifiedModule {
  moduleId: string;
  reason: ProgramDiagnostic["reason"];
  symbolCount: number;
  files: string[];
  /** Up to a few symbol ids so the operator can locate the code (`anatomia where`). */
  sampleSymbolIds: string[];
}

export interface ProgramDomainDiagnosis {
  repoPath: string;
  /** The loaded `.anatomia/layers.json` (default config when absent). */
  config: ProgramDomainConfig;
  /** True when `.anatomia/layers.json` exists, including an intentionally empty declaration. */
  configPresent: boolean;
  layers: ProgramLayerSummary[];
  modules: ProgramModuleClassification[];
  unclassified: ProgramUnclassifiedModule[];
  totals: { modules: number; symbols: number; domains: number; unclassifiedModules: number; unclassifiedSymbols: number };
  graph: ProgramDomainGraph;
}

const SAMPLE_SYMBOLS = 3;

/**
 * Classify + derive program domains for a repo and shape the result for
 * operators. `sourceRevision` is informational (stamped into the graph).
 */
export async function diagnoseProgramDomains(input: {
  repoPath: string;
  functions: readonly FunctionNode[];
  sourceRevision?: string;
  config?: ProgramDomainConfig;
}): Promise<ProgramDomainDiagnosis> {
  let config: ProgramDomainConfig;
  let configPresent: boolean;
  if (input.config) {
    config = input.config;
    // Injected configurations are test/application inputs, which do not carry
    // a file-presence signal. Preserve the previous useful convention here.
    configPresent = config.layers.length > 0;
  } else {
    const loaded = await loadProgramDomainConfigWithPresence(input.repoPath);
    config = loaded.config;
    configPresent = loaded.present;
  }
  const { modules, symbols } = buildProgramDomainInputs(input.repoPath, input.functions);
  const classified = classifyProgramModules(modules, symbols, config);
  const graph = deriveProgramDomains({
    projectId: normalizeIdSegment(basename(input.repoPath), "project"),
    sourceRevision: input.sourceRevision ?? "diagnose",
    modules,
    symbols,
    config,
  });

  const symbolsByModule = new Map<string, ProgramSymbol[]>();
  for (const symbol of symbols) symbolsByModule.set(symbol.moduleId, [...(symbolsByModule.get(symbol.moduleId) ?? []), symbol]);
  const filesOf = (module: ModuleUnit): string[] =>
    [...new Set((symbolsByModule.get(module.id) ?? []).map((symbol) => symbol.path))].sort();

  const moduleViews: ProgramModuleClassification[] = classified.map((item) => ({
    moduleId: item.module.id,
    layer: item.layer,
    source: item.source,
    symbolCount: (symbolsByModule.get(item.module.id) ?? []).length,
    files: filesOf(item.module),
  }));

  const moduleById = new Map(modules.map((module) => [module.id, module]));
  const unclassified: ProgramUnclassifiedModule[] = graph.diagnostics.map((diagnostic) => {
    const module = moduleById.get(diagnostic.moduleId);
    return {
      moduleId: diagnostic.moduleId,
      reason: diagnostic.reason,
      symbolCount: diagnostic.symbolIds.length,
      files: module ? filesOf(module) : [],
      sampleSymbolIds: diagnostic.symbolIds.slice(0, SAMPLE_SYMBOLS),
    };
  });

  const layerAgg = new Map<string, ProgramLayerSummary>();
  for (const domain of graph.domains) {
    const entry = layerAgg.get(domain.layer) ?? { layer: domain.layer, domainCount: 0, moduleCount: 0, symbolCount: 0 };
    entry.domainCount += 1;
    entry.moduleCount += domain.moduleIds.length;
    entry.symbolCount += domain.codeSymbolIds.length;
    layerAgg.set(domain.layer, entry);
  }
  const layers = [...layerAgg.values()].sort((left, right) => left.layer.localeCompare(right.layer));

  return {
    repoPath: input.repoPath,
    config,
    configPresent,
    layers,
    modules: moduleViews,
    unclassified,
    totals: {
      modules: modules.length,
      symbols: symbols.length,
      domains: graph.domains.length,
      unclassifiedModules: unclassified.length,
      unclassifiedSymbols: unclassified.reduce((sum, item) => sum + item.symbolCount, 0),
    },
    graph,
  };
}
