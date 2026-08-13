import { createHash } from "node:crypto";
import { canonicalJson } from "../../knowledge/canonical-json.js";
import { programDomainEntityId } from "../../knowledge/identity.js";
import type { ModuleUnit } from "../../modules/types.js";
import { classifyProgramModules } from "./classify.js";
import type { ProgramDiagnostic, ProgramDomain, ProgramDomainConfig, ProgramDomainGraph, ProgramSymbol } from "./types.js";

function fingerprint(value: unknown): string { return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`; }
function parent(path: string): string { const index = path.lastIndexOf("/"); return index < 0 ? "." : path.slice(0, index); }
function adjacent(left: ModuleUnit, right: ModuleUnit): boolean { return parent(left.id) === parent(right.id) || left.id.startsWith(`${right.id}/`) || right.id.startsWith(`${left.id}/`); }

/** Derive stable program-domain components; no default layer is ever assigned. */
export function deriveProgramDomains(input: {
  projectId: string;
  sourceRevision: string;
  modules: readonly ModuleUnit[];
  symbols: readonly ProgramSymbol[];
  coupling?: ReadonlyMap<string, number>;
  config: ProgramDomainConfig;
}): ProgramDomainGraph {
  const classified = classifyProgramModules(input.modules, input.symbols, input.config);
  const symbolsByModule = new Map<string, ProgramSymbol[]>();
  for (const symbol of input.symbols) symbolsByModule.set(symbol.moduleId, [...(symbolsByModule.get(symbol.moduleId) ?? []), symbol]);
  const diagnostics: ProgramDiagnostic[] = classified.filter((item) => item.layer === null).map((item) => ({ kind: "unclassified", moduleId: item.module.id, symbolIds: (symbolsByModule.get(item.module.id) ?? []).map((symbol) => symbol.id).sort(), reason: "no-layer-rule" }));
  const groups = new Map<string, ModuleUnit[]>();
  for (const item of classified) if (item.layer) groups.set(item.layer, [...(groups.get(item.layer) ?? []), item.module]);
  const domains: ProgramDomain[] = [];
  for (const [layer, modules] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const parentIndex = modules.map((_, index) => index);
    const find = (index: number): number => parentIndex[index] === index ? index : (parentIndex[index] = find(parentIndex[index]!));
    const join = (left: number, right: number): void => { parentIndex[find(left)] = find(right); };
    for (let left = 0; left < modules.length; left++) for (let right = left + 1; right < modules.length; right++) {
      const key = [modules[left]!.id, modules[right]!.id].sort().join("\0");
      if (adjacent(modules[left]!, modules[right]!) && (input.coupling?.get(key) ?? 0) >= input.config.mergeCouplingThreshold) join(left, right);
    }
    const components = new Map<number, ModuleUnit[]>();
    modules.forEach((module, index) => components.set(find(index), [...(components.get(find(index)) ?? []), module]));
    for (const component of components.values()) {
      const moduleIds = component.map((module) => module.id).sort();
      const codeSymbolIds = moduleIds.flatMap((moduleId) => (symbolsByModule.get(moduleId) ?? []).map((symbol) => symbol.id)).sort();
      domains.push({
        id: programDomainEntityId(input.projectId, `${layer}\0${moduleIds.join("\0")}`),
        layer,
        moduleIds,
        codeSymbolIds,
      });
    }
  }
  domains.sort((left, right) => left.id.localeCompare(right.id));
  return { schemaVersion: 1, projectId: input.projectId, sourceRevision: input.sourceRevision, definitionFingerprint: fingerprint({ config: input.config, modules: input.modules, symbols: input.symbols, coupling: [...(input.coupling ?? new Map()).entries()].sort() }), domains, diagnostics };
}
