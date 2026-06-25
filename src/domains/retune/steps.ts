/**
 * src/domains/retune/steps.ts — The re-tune steps (LLM + mechanical).
 *
 * Each function maps to a numbered step of spec/feature/domain-retune.md:
 *   1 step1Domains   (LLM)  decide domains + big modules
 *   2 step2Assign    (LLM)  assign directories to domain/module
 *     assembleFromAssignments (mechanical) — build taxonomy from 1+2
 *   3 step3Group     (LLM)  group leftover directories into new modules
 *     applyGroups    (mechanical)
 *   5 step5Split     (LLM)  split over-large domains
 *   6 step6Merge     (LLM)  merge tiny modules
 * (step 4 = register.ts writes the assembled taxonomy; step 7 = state.ts gate.)
 *
 * SRP: orchestration of prompts + llm + taxonomy-ops into step results. The data
 * mutations live in taxonomy-ops.ts; the prompts in prompts.ts.
 */

import type { LLMClient } from "../card.js";
import type { DirStat, Taxonomy, NodeSummary, StepLog } from "./types.js";
import { callLlmJson, asArray } from "./llm.js";
import { step1Prompt, step2Prompt, step3Prompt, step5Prompt, step6Prompt } from "./prompts.js";
import type { DomainSkeleton } from "./prompts.js";
import {
  emptyTaxonomy,
  findOrCreateDomain,
  findOrCreateModule,
  addDir,
  moduleNodeCounts,
  splitDomain,
  mergeModules,
  kebab,
} from "./taxonomy-ops.js";

export const MAX_MODULES_PER_DOMAIN = Number(process.env.RETUNE_MAX_MODULES_PER_DOMAIN ?? 6);
export const MIN_NODES_PER_MODULE = Number(process.env.RETUNE_MIN_NODES_PER_MODULE ?? 3);
/** Confidence below this flags an assignment for human review. */
const LOW_CONFIDENCE = 0.5;

// ── Step 1 ──────────────────────────────────────────────────────────────────

export async function step1Domains(
  llm: LLMClient,
  input: { project: string; purpose: string; specHeadings: string[]; dirs: DirStat[]; screens?: string[] },
): Promise<{ skeleton: DomainSkeleton[]; log: StepLog }> {
  const parsed = await callLlmJson<{ domains?: unknown }>(llm, step1Prompt(input));
  const skeleton: DomainSkeleton[] = asArray<any>(parsed.domains).map((d) => ({
    name: kebab(d?.name ?? ""),
    description: String(d?.description ?? ""),
    moduleHints: asArray<any>(d?.moduleHints).map((m) => ({
      name: kebab(m?.name ?? ""),
      description: String(m?.description ?? ""),
    })),
  }));
  return {
    skeleton,
    log: {
      step: 1,
      title: "目的+specからドメイン/大モジュールを決定",
      llm: true,
      summary: `${skeleton.length} domains, ${skeleton.reduce((s, d) => s + d.moduleHints.length, 0)} module hints`,
    },
  };
}

// ── Step 2 ──────────────────────────────────────────────────────────────────

export interface Assignment {
  dir: string;
  domain: string;
  module: string;
  confidence: number;
}

export async function step2Assign(
  llm: LLMClient,
  input: { skeleton: DomainSkeleton[]; dirs: DirStat[] },
): Promise<{ assignments: Assignment[]; log: StepLog }> {
  const parsed = await callLlmJson<{ assignments?: unknown }>(
    llm,
    step2Prompt({ domains: input.skeleton, dirs: input.dirs }),
  );
  const assignments: Assignment[] = asArray<any>(parsed.assignments).map((a) => ({
    dir: String(a?.dir ?? "").replace(/\\/g, "/"),
    domain: kebab(a?.domain ?? ""),
    module: a?.module ? kebab(a.module) : "",
    confidence: typeof a?.confidence === "number" ? a.confidence : 0.5,
  }));
  const assigned = assignments.filter((a) => a.module && a.domain).length;
  return {
    assignments,
    log: {
      step: 2,
      title: "大きいノードをドメイン/モジュールに関連付け",
      llm: true,
      summary: `${assigned}/${input.dirs.length} dirs assigned`,
    },
  };
}

/**
 * Build the taxonomy from step-1 skeleton + step-2 assignments (mechanical part
 * of step 4). Returns the taxonomy plus the directories left unassigned and any
 * low-confidence notes.
 */
export function assembleFromAssignments(
  project: string,
  skeleton: DomainSkeleton[],
  assignments: Assignment[],
  dirs: DirStat[],
): { taxonomy: Taxonomy; leftovers: DirStat[]; lowConfidence: string[] } {
  const t = emptyTaxonomy(project);
  const domainDesc = new Map(skeleton.map((d) => [d.name, d.description]));
  const hintDesc = new Map<string, string>();
  for (const d of skeleton) for (const m of d.moduleHints) hintDesc.set(`${d.name}/${m.name}`, m.description);

  const byDir = new Map(assignments.map((a) => [a.dir, a]));
  const leftovers: DirStat[] = [];
  const lowConfidence: string[] = [];

  for (const ds of dirs) {
    const a = byDir.get(ds.dir);
    if (!a || !a.module || !a.domain || !domainDesc.has(a.domain)) {
      leftovers.push(ds);
      continue;
    }
    const dom = findOrCreateDomain(t, a.domain, domainDesc.get(a.domain) ?? a.domain);
    const mod = findOrCreateModule(dom, a.module, hintDesc.get(`${a.domain}/${a.module}`) ?? a.module);
    addDir(mod, ds.dir);
    if (a.confidence < LOW_CONFIDENCE) lowConfidence.push(`${ds.dir} → ${a.domain}/${a.module} (conf ${a.confidence})`);
  }
  return { taxonomy: t, leftovers, lowConfidence };
}

// ── Step 3 ──────────────────────────────────────────────────────────────────

export interface LeftoverGroup {
  domain: string;
  module: string;
  description: string;
  dirs: string[];
}

export async function step3Group(
  llm: LLMClient,
  input: { skeleton: DomainSkeleton[]; leftovers: DirStat[] },
): Promise<{ groups: LeftoverGroup[]; log: StepLog }> {
  if (input.leftovers.length === 0) {
    return { groups: [], log: { step: 3, title: "小ノードのグループ化", llm: false, summary: "no leftovers" } };
  }
  const parsed = await callLlmJson<{ groups?: unknown }>(
    llm,
    step3Prompt({ domains: input.skeleton, leftovers: input.leftovers }),
  );
  const groups: LeftoverGroup[] = asArray<any>(parsed.groups).map((g) => ({
    domain: kebab(g?.domain ?? "misc"),
    module: kebab(g?.module ?? ""),
    description: String(g?.description ?? ""),
    dirs: asArray<any>(g?.dirs).map((d) => String(d).replace(/\\/g, "/")),
  }));
  return {
    groups,
    log: {
      step: 3,
      title: "結合できない小ノードを新モジュールにグループ化",
      llm: true,
      summary: `${groups.length} new groups covering ${groups.reduce((s, g) => s + g.dirs.length, 0)} dirs`,
    },
  };
}

/** Apply leftover groups into the taxonomy (mechanical). Returns covered dirs. */
export function applyGroups(t: Taxonomy, groups: LeftoverGroup[]): Set<string> {
  const covered = new Set<string>();
  for (const g of groups) {
    if (!g.module) continue;
    const dom = findOrCreateDomain(t, g.domain || "misc", g.description);
    const mod = findOrCreateModule(dom, g.module, g.description);
    for (const dir of g.dirs) {
      addDir(mod, dir);
      covered.add(dir);
    }
  }
  return covered;
}

// ── Step 5 ──────────────────────────────────────────────────────────────────

export async function step5Split(
  llm: LLMClient,
  t: Taxonomy,
  maxModules: number = MAX_MODULES_PER_DOMAIN,
): Promise<{ log: StepLog }> {
  const oversized = t.domains.filter((d) => d.modules.length > maxModules);
  let splits = 0;
  for (const d of oversized) {
    const parsed = await callLlmJson<{ subdomains?: unknown }>(llm, step5Prompt({ domain: d }));
    const subdomains = asArray<any>(parsed.subdomains).map((s) => ({
      name: kebab(s?.name ?? ""),
      description: String(s?.description ?? ""),
      modules: asArray<any>(s?.modules).map((m) => String(m)),
    }));
    if (subdomains.length >= 2 && splitDomain(t, d.name, subdomains)) splits++;
  }
  return {
    log: {
      step: 5,
      title: "モジュール過多ドメインを分割",
      llm: oversized.length > 0,
      summary: oversized.length === 0 ? `no domain over ${maxModules} modules` : `split ${splits}/${oversized.length} oversized domains`,
    },
  };
}

// ── Step 6 ──────────────────────────────────────────────────────────────────

export async function step6Merge(
  llm: LLMClient,
  t: Taxonomy,
  nodes: NodeSummary[],
  minNodes: number = MIN_NODES_PER_MODULE,
): Promise<{ log: StepLog }> {
  const counts = moduleNodeCounts(t, nodes);
  const small: { name: string; domain: string; nodeCount: number; description: string }[] = [];
  for (const d of t.domains) {
    for (const m of d.modules) {
      const c = counts.get(`${d.name}/${m.name}`) ?? 0;
      if (c < minNodes) small.push({ name: m.name, domain: d.name, nodeCount: c, description: m.description });
    }
  }
  if (small.length < 2) {
    return { log: { step: 6, title: "小モジュールの統合", llm: false, summary: `${small.length} tiny modules (<${minNodes} fns); nothing to merge` } };
  }
  const parsed = await callLlmJson<{ merges?: unknown }>(llm, step6Prompt({ smallModules: small }));
  const merges = asArray<any>(parsed.merges).map((m) => ({
    domain: kebab(m?.domain ?? ""),
    into: kebab(m?.into ?? ""),
    description: String(m?.description ?? ""),
    modules: asArray<any>(m?.modules).map((x) => String(x)),
  }));
  let applied = 0;
  for (const mg of merges) {
    if (mg.into && mg.modules.length >= 2 && mergeModules(t, mg.domain, mg.into, mg.description, mg.modules)) applied++;
  }
  return {
    log: {
      step: 6,
      title: "多すぎる小モジュールを統合",
      llm: true,
      summary: `${small.length} tiny modules; applied ${applied} merges`,
    },
  };
}
