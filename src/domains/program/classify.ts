import type { ModuleUnit } from "../../modules/types.js";
import { isDependencyArtifactPath } from "./deps.js";
import type { ClassifiedModule, ProgramDomainConfig, ProgramSymbol } from "./types.js";

function pathMatches(glob: string, value: string): boolean {
  const expression = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*");
  return new RegExp(`^${expression}$`).test(value.replace(/\\/g, "/"));
}

/** Classify modules in builtin (dependency artifacts) → config → framework → dependency heuristic order. */
export function classifyProgramModules(
  modules: readonly ModuleUnit[],
  symbols: readonly ProgramSymbol[],
  config: ProgramDomainConfig,
): ClassifiedModule[] {
  const symbolsByModule = new Map<string, ProgramSymbol[]>();
  for (const symbol of symbols) symbolsByModule.set(symbol.moduleId, [...(symbolsByModule.get(symbol.moduleId) ?? []), symbol]);
  return [...modules].sort((a, b) => a.id.localeCompare(b.id)).map((module) => {
    const members = symbolsByModule.get(module.id) ?? [];
    const paths = members.length > 0 ? members.map((symbol) => symbol.path) : module.files;
    if (paths.length > 0 && paths.every((path) => isDependencyArtifactPath(path))) return { module, layer: "infrastructure", source: "builtin" };
    for (const rule of config.layers) if (members.some((symbol) => pathMatches(rule.glob, symbol.path))) return { module, layer: rule.layer, source: "config" };
    const frameworkLayer = members.map((symbol) => symbol.frameworkLayer).filter((layer): layer is string => Boolean(layer)).sort()[0];
    if (frameworkLayer) return { module, layer: frameworkLayer, source: "framework" };
    const dependencies = new Set(members.flatMap((symbol) => symbol.dependencies ?? []));
    if (dependencies.has("ui")) return { module, layer: "presentation", source: "heuristic" };
    if (dependencies.has("persistence")) return { module, layer: "infrastructure", source: "heuristic" };
    return { module, layer: null, source: null };
  });
}
