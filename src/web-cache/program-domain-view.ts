// @spec リファクタリング提案生成 + 調整タスク発行 (task sink)

import { basename, isAbsolute, relative } from "node:path";
import type { AnalysisContext } from "../core.js";
import { deriveProgramDomains, loadProgramDomainConfig } from "../domains/program/index.js";
import { normalizeIdSegment } from "../knowledge/identity.js";
import type { DomainCorrespondenceQuery } from "../knowledge/domain-correspondence/types.js";
import type { ModuleEvaluation } from "../modules/types.js";
import type { VisData } from "../adapters/web/vis-data.js";
import type { ProgramDomainViewPayload } from "./types.js";
import { buildRefactoringProposals, type RefactoringProposal, type RefactoringSignal } from "../review/refactoring-proposals.js";
import type { ReviewReport } from "../review/build.js";
import type { KnowledgeGraph } from "../knowledge/types.js";

function pathOf(ctx: AnalysisContext, file: string): string {
  const normalized = file.replace(/\\/g, "/");
  return isAbsolute(file) ? relative(ctx.repoPath, file).replace(/\\/g, "/") : normalized;
}

function moduleIdOf(ctx: AnalysisContext, moduleId: string): string {
  return pathOf(ctx, moduleId).replace(/^\.\//, "");
}

const LAYER_RANK: Record<string, number> = { infrastructure: 0, domain: 1, application: 2, presentation: 3 };

interface ModuleDependency {
  fromDomain: string;
  toDomain: string;
  fromModuleId: string;
  toModuleId: string;
  weight: number;
}

function edgeWeight(edge: VisData["edges"][number]): number {
  return edge.memberEdgeCount ?? 1;
}

function addWeight<T extends { weight: number }>(items: Map<string, T>, key: string, item: Omit<T, "weight">, weight: number): void {
  const current = items.get(key);
  items.set(key, { ...item, weight: (current?.weight ?? 0) + weight } as T);
}

function compareModuleDependencies(left: { fromModuleId: string; toModuleId: string }, right: { fromModuleId: string; toModuleId: string }): number {
  return left.fromModuleId.localeCompare(right.fromModuleId) || left.toModuleId.localeCompare(right.toModuleId);
}

/** Build the complete program-domain read model during cache preparation. */
export async function buildProgramDomainViewPayload(
  ctx: AnalysisContext,
  evaluation: ModuleEvaluation,
  graph: VisData,
  correspondence: DomainCorrespondenceQuery,
  review?: ReviewReport,
  knowledgeState?: KnowledgeGraph,
): Promise<ProgramDomainViewPayload> {
  const config = await loadProgramDomainConfig(ctx.repoPath);
  const moduleByAnchor = new Map(evaluation.modules.flatMap((module) => module.anchors.map((anchor) => [String(anchor), module.id])));
  const symbols = ctx.functions.flatMap((fn) => fn.id && moduleByAnchor.get(String(fn.id))
    ? [{ id: String(fn.id), moduleId: moduleByAnchor.get(String(fn.id))!, path: pathOf(ctx, fn.sourceRange.filePath) }]
    : []);
  const coupling = new Map<string, number>();
  for (const edge of graph.edges) {
    const from = moduleByAnchor.get(edge.from); const to = moduleByAnchor.get(edge.to);
    if (from && to && from !== to) {
      const key = [from, to].sort().join("\0");
      coupling.set(key, (coupling.get(key) ?? 0) + edgeWeight(edge));
    }
  }
  const derived = deriveProgramDomains({ projectId: normalizeIdSegment(basename(ctx.repoPath), "project"), sourceRevision: "prepared", modules: evaluation.modules, symbols, coupling, config });
  const cohesion = new Map(evaluation.cohesion.map((item) => [item.moduleId, item.cohesion]));
  const misfits = new Map<string, number>();
  for (const item of evaluation.misfits) misfits.set(item.homeModule, (misfits.get(item.homeModule) ?? 0) + 1);
  const ownerByProgram = new Map(correspondence.programDomains.map((item) => [item.programDomainId, item]));
  const byAnchor = new Map<string, string>();
  const domainByModule = new Map<string, string>();
  for (const domain of derived.domains) {
    for (const anchor of domain.codeSymbolIds) byAnchor.set(anchor, domain.id);
    for (const moduleId of domain.moduleIds) domainByModule.set(moduleId, domain.id);
  }
  const moduleDependencies = new Map<string, ModuleDependency>();
  for (const edge of graph.edges) {
    const fromModuleId = moduleByAnchor.get(edge.from); const toModuleId = moduleByAnchor.get(edge.to);
    if (!fromModuleId || !toModuleId) continue;
    const fromDomain = domainByModule.get(fromModuleId); const toDomain = domainByModule.get(toModuleId);
    if (!fromDomain || !toDomain) continue;
    const key = `${fromDomain}\0${toDomain}\0${fromModuleId}\0${toModuleId}`;
    addWeight(moduleDependencies, key, { fromDomain, toDomain, fromModuleId, toModuleId }, edgeWeight(edge));
  }
  const domains = derived.domains.map((domain) => ({
    ...domain,
    cohesion: domain.moduleIds.length ? domain.moduleIds.reduce((sum, id) => sum + (cohesion.get(id) ?? 1), 0) / domain.moduleIds.length : null,
    modularity: evaluation.modularity,
    misfitCount: domain.moduleIds.reduce((sum, id) => sum + (misfits.get(id) ?? 0), 0),
    modules: domain.moduleIds.map((moduleId) => ({ moduleId, cohesion: cohesion.get(moduleId) ?? null, misfitCount: misfits.get(moduleId) ?? 0 })),
    moduleDependencies: [...moduleDependencies.values()]
      .filter((dependency) => dependency.fromDomain === domain.id && dependency.toDomain === domain.id)
      .map(({ fromModuleId, toModuleId, weight }) => ({ fromModuleId, toModuleId, weight }))
      .sort(compareModuleDependencies),
    businessDomains: ownerByProgram.get(domain.id)?.businessDomains ?? [],
    unlinkedCodeSymbolCount: ownerByProgram.get(domain.id)?.unlinkedCodeSymbolCount ?? 0,
    unlinkedCodeSymbols: ownerByProgram.get(domain.id)?.unlinkedCodeSymbols ?? [],
  }));
  const dependencies = new Map<string, { from: string; to: string; weight: number; layerViolation: boolean }>();
  const dependencyTargets = new Map<string, Set<string>>();
  const layerByDomain = new Map(derived.domains.map((domain) => [domain.id, LAYER_RANK[domain.layer] ?? 0]));
  for (const edge of graph.edges) {
    const from = byAnchor.get(edge.from); const to = byAnchor.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from}\0${to}`; const current = dependencies.get(key);
    const violation = (layerByDomain.get(from) ?? 0) < (layerByDomain.get(to) ?? 0);
    dependencies.set(key, { from, to, weight: (current?.weight ?? 0) + edgeWeight(edge), layerViolation: violation });
    if (violation) {
      const targets = dependencyTargets.get(key) ?? new Set<string>();
      targets.add(edge.from);
      targets.add(edge.to);
      dependencyTargets.set(key, targets);
    }
  }
  const classes = graph.views.class;
  const location = (id: string) => {
    const fn = ctx.functions.find((candidate) => String(candidate.id) === id);
    const line = fn?.sourceRange.start?.line;
    return { stableId: id, file: fn ? pathOf(ctx, fn.sourceRange.filePath) : "", line: line !== undefined ? line + 1 : 0 };
  };
  const signals: RefactoringSignal[] = [
    ...evaluation.misfits.map((misfit) => ({ rule: "misfit" as const, action: "move" as const, targets: [location(String(misfit.anchor))], evidence: { metric: "external-ties", value: misfit.attractedTies, threshold: misfit.homeTies, detail: `${misfit.name}: ${moduleIdOf(ctx, misfit.homeModule)} -> ${moduleIdOf(ctx, misfit.attractedTo)}` }, impactRadius: { codeSymbols: 1, modules: 2, domains: 0 } })),
    ...evaluation.cohesion.filter((item) => item.cohesion < 0.5).map((item) => {
      const module = evaluation.modules.find((candidate) => candidate.id === item.moduleId);
      const member = module?.anchors[0] ? location(String(module.anchors[0])) : null;
      return { rule: "low-cohesion" as const, action: "split-module" as const, targets: [{ stableId: `module:${moduleIdOf(ctx, item.moduleId)}`, file: member?.file ?? (module?.files[0] ? pathOf(ctx, module.files[0]) : ""), line: member?.line || 1 }], evidence: { metric: "cohesion", value: item.cohesion, threshold: 0.5, detail: `module ${moduleIdOf(ctx, item.moduleId)}` }, impactRadius: { codeSymbols: item.size, modules: 1, domains: 1 } };
    }),
    ...[...dependencies.entries()].filter(([, item]) => item.layerViolation).map(([key, item]) => {
      const targets = [...(dependencyTargets.get(key) ?? [])].map(location);
      const modules = new Set(targets.map((target) => moduleByAnchor.get(target.stableId)).filter((module): module is string => Boolean(module)));
      return { rule: "layer-violation" as const, action: "layer-fix" as const, targets, evidence: { metric: "layer-edge-weight", value: item.weight, threshold: 0, detail: `${item.from} -> ${item.to}` }, impactRadius: { codeSymbols: targets.length, modules: modules.size, domains: 2 } };
    }),
    ...(review?.cycles ?? []).map((cycle) => ({ rule: "cycle" as const, action: "break-cycle" as const, targets: cycle.map((item) => ({ stableId: String(item.anchor), file: item.file, line: item.line })), evidence: { metric: "cycle-members", value: cycle.length, threshold: 0, detail: "review/cycle" }, impactRadius: { codeSymbols: cycle.length, modules: cycle.length, domains: 0 } })),
    ...(review?.structuralDup ?? []).map((dup) => ({ rule: "structural-dup" as const, action: "dedupe" as const, targets: dup.copies.map((item) => ({ stableId: String(item.anchor), file: item.file, line: item.line })), evidence: { metric: "duplicate-copies", value: dup.copies.length, threshold: 1, detail: dup.name }, impactRadius: { codeSymbols: dup.copies.length, modules: dup.copies.length, domains: 0 } })),
  ];
  return {
    layers: [...new Set(domains.map((domain) => domain.layer))].map((layer) => ({ layer, domains: domains.filter((domain) => domain.layer === layer) })),
    diagnostics: derived.diagnostics,
    classDiagram: { nodes: classes.nodes, edges: classes.edges.filter((edge) => ["implements", "overrides", "depends", "calls", "reads", "writes"].some((kind) => edge.label.startsWith(kind))) },
    dependencies: [...dependencies.values()]
      .map((dependency) => ({
        ...dependency,
        modules: [...moduleDependencies.values()]
          .filter((moduleDependency) => moduleDependency.fromDomain === dependency.from && moduleDependency.toDomain === dependency.to)
          .map(({ fromModuleId, toModuleId, weight }) => ({ fromModuleId, toModuleId, weight }))
          .sort(compareModuleDependencies),
      }))
      .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)),
    modularity: evaluation.modularity,
    proposals: buildRefactoringProposals(signals).map((proposal) => {
      const task = knowledgeState?.nodes.get(proposal.proposalId)?.data?.task as { id?: unknown; status?: unknown } | undefined;
      return typeof task?.id === "string" && (task.status === "open" || task.status === "done") ? { ...proposal, task: { id: task.id, status: task.status } } : proposal;
    }),
  };
}
