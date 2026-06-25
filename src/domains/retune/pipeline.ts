/**
 * src/domains/retune/pipeline.ts — The domain re-tune pipeline (orchestration).
 *
 * Runs the 7 steps of spec/feature/domain-retune.md against a repo: analyze →
 * mechanical stats → LLM domain/module decisions → assemble → register → state
 * gate. The LLM is injected (providers default = `claude -p`) so the pipeline is
 * provider-agnostic and the steps stay testable in isolation.
 *
 * SRP: sequence the steps + persist. The decisions live in steps.ts, the
 * mutations in taxonomy-ops.ts, the writes in register.ts.
 */

import { analyze } from "../../core.js";
import type { AnalysisContext } from "../../core.js";
import type { LLMClient } from "../card.js";
import type { RetuneReport, StepLog, NodeSummary } from "./types.js";
import { summarizeNodes, classifyBySize, dirStats, DEFAULT_LARGE_PERCENTILE } from "./graph-stats.js";
import { gatherPurpose, gatherSpecHeadings } from "./gather.js";
import {
  step1Domains,
  step2Assign,
  assembleFromAssignments,
  step3Group,
  applyGroups,
  step5Split,
  step6Merge,
  MAX_MODULES_PER_DOMAIN,
  MIN_NODES_PER_MODULE,
} from "./steps.js";
import { unassignedNodes } from "./grouping.js";
import { registerTaxonomy } from "./register.js";
import { detectScreenPlan, persistScreenGraph, summarizeScreens } from "./screens.js";
import { loadState, saveState, recordPass, shouldHaltForHuman } from "./state.js";

export interface RetuneOptions {
  largePercentile?: number;
  maxModulesPerDomain?: number;
  minNodesPerModule?: number;
  /** ISO timestamp for the pass record (injectable for determinism/tests). */
  now?: string;
}

const UNASSIGNED_SAMPLE = 20;

/** Directories that contain at least one "large" node. */
function partitionDirs(nodes: NodeSummary[], large: NodeSummary[]): { largeDirs: Set<string> } {
  const largeIds = new Set(large.map((n) => n.id));
  const largeDirs = new Set<string>();
  for (const n of nodes) if (largeIds.has(n.id)) largeDirs.add(n.dir);
  return { largeDirs };
}

/**
 * Run the re-tune on an already-analyzed context (the testable core). Gathers
 * purpose/spec from the repo, runs steps 1–6, registers (4), and gates (7).
 */
export async function runRetuneOnContext(
  ctx: AnalysisContext,
  input: { project: string; llm: LLMClient; options?: RetuneOptions },
): Promise<RetuneReport> {
  const opts = input.options ?? {};
  const steps: StepLog[] = [];

  // ── Mechanical stats ──────────────────────────────────────────────────────
  const nodes = await summarizeNodes(ctx);
  const split = classifyBySize(nodes, opts.largePercentile ?? DEFAULT_LARGE_PERCENTILE);
  const dirs = dirStats(nodes);
  const { largeDirs } = partitionDirs(nodes, split.large);
  const heavyDirs = dirs.filter((d) => largeDirs.has(d.dir));
  const smallOnlyDirs = dirs.filter((d) => !largeDirs.has(d.dir));

  const [purpose, specHeadings] = await Promise.all([
    gatherPurpose(ctx.repoPath),
    gatherSpecHeadings(ctx.repoPath),
  ]);

  // ── Screen composition (auto-learned, deterministic) ──────────────────────
  // Detect the UI screens up front so (a) the step-1 LLM prompt is screen-aware
  // and (b) the deterministic screen domain can be folded in after step 6.
  const { graph: screenGraph, plan: screenPlan } = await detectScreenPlan(ctx);
  const screens = summarizeScreens(screenGraph);

  // ── Step 1: domains + big modules ─────────────────────────────────────────
  const s1 = await step1Domains(input.llm, { project: input.project, purpose, specHeadings, dirs, screens });
  steps.push(s1.log);

  // ── Step 2: assign heavy (large-node) directories ─────────────────────────
  const s2 = await step2Assign(input.llm, { skeleton: s1.skeleton, dirs: heavyDirs });
  steps.push(s2.log);

  // ── Step 4 (assemble) + carry leftovers to step 3 ─────────────────────────
  const assembled = assembleFromAssignments(input.project, s1.skeleton, s2.assignments, heavyDirs);
  const taxonomy = assembled.taxonomy;

  // ── Step 3: group leftover (small-only + unassigned-heavy) directories ─────
  const leftoverByDir = new Map<string, (typeof dirs)[number]>();
  for (const d of [...smallOnlyDirs, ...assembled.leftovers]) leftoverByDir.set(d.dir, d);
  const leftovers = [...leftoverByDir.values()];
  const s3 = await step3Group(input.llm, { skeleton: s1.skeleton, leftovers });
  applyGroups(taxonomy, s3.groups);
  steps.push(s3.log);

  // ── Step 5: split over-large domains ──────────────────────────────────────
  const s5 = await step5Split(input.llm, taxonomy, opts.maxModulesPerDomain ?? MAX_MODULES_PER_DOMAIN);
  steps.push(s5.log);

  // ── Step 6: merge tiny modules ────────────────────────────────────────────
  const s6 = await step6Merge(input.llm, taxonomy, nodes, opts.minNodesPerModule ?? MIN_NODES_PER_MODULE);
  steps.push(s6.log);

  // ── Step 8: fold the auto-learned screen composition in as a domain ───────
  // Deterministic (no LLM) and added after the LLM steps so split/merge never
  // reshape it. Owns its screen files by path → surfaces in the Domain View and
  // feeds supply/verify like any generated domain.
  if (screenPlan) {
    taxonomy.domains.push(screenPlan);
    steps.push({
      step: 8,
      title: "画面構成を自動検出しドメイン化",
      llm: false,
      summary: `${screenGraph.summary.total} screens, ${screenPlan.modules.length} screen modules, ${screenGraph.summary.edges} edges`,
    });
  }

  // ── Unassigned transparency ───────────────────────────────────────────────
  const unassigned = unassignedNodes(taxonomy, nodes);
  taxonomy.unassigned = {
    count: unassigned.length,
    sample: unassigned.slice(0, UNASSIGNED_SAMPLE).map((n) => `${n.relPath}:${n.name}`),
  };

  // ── State + step 4 register + step 7 gate ─────────────────────────────────
  const prior = await loadState(ctx.repoPath, input.project);
  taxonomy.iterations = prior.iterations + 1;
  const { written, ontologyDir } = await registerTaxonomy(ctx.repoPath, taxonomy);
  // Persist the full screen graph (composition + navigation) alongside the taxonomy.
  if (screenGraph.summary.total > 0) {
    written.push(await persistScreenGraph(ctx.repoPath, input.project, screenGraph));
  }
  const next = recordPass(prior, taxonomy, opts.now);
  await saveState(ctx.repoPath, next);

  const haltForHuman = shouldHaltForHuman(next);
  const humanReviewNotes: string[] = [];
  if (assembled.lowConfidence.length) {
    humanReviewNotes.push(`低確信の割当 ${assembled.lowConfidence.length} 件:`);
    humanReviewNotes.push(...assembled.lowConfidence.map((s) => `  - ${s}`));
  }
  if (taxonomy.unassigned.count > 0) {
    humanReviewNotes.push(`未割当ノード ${taxonomy.unassigned.count} 件（先頭 ${UNASSIGNED_SAMPLE}）:`);
    humanReviewNotes.push(...taxonomy.unassigned.sample.map((s) => `  - ${s}`));
  }
  if (haltForHuman) {
    humanReviewNotes.unshift(
      `反復 ${next.iterations} 回に到達（上限 ${prior.iterations >= 0 ? "RETUNE_HALT_AFTER" : ""}）。自動反復を停止し人間判断を仰ぐ（step 7）。`,
    );
  }

  return {
    project: input.project,
    iteration: next.iterations,
    taxonomy,
    steps,
    written,
    ontologyDir,
    haltForHuman,
    humanReviewNotes,
  };
}

/** Analyze the repo, then run the re-tune on it. */
export async function runRetune(input: {
  repoPath: string;
  project: string;
  llm: LLMClient;
  options?: RetuneOptions;
}): Promise<RetuneReport> {
  const ctx = await analyze(input.repoPath, { quiet: true });
  return runRetuneOnContext(ctx, { project: input.project, llm: input.llm, options: input.options });
}
