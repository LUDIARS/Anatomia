/**
 * src/domains/retune/state.ts — Persisted re-tune iteration state (step 7).
 *
 * The pass count lives in .anatomia/retune-state.json (local, gitignored). After
 * HALT_AFTER_ITERATIONS automatic passes the pipeline stops self-iterating and
 * asks for human judgment (spec/feature/domain-retune.md step 7) — the taxonomy
 * has converged enough that further unattended LLM churn risks drift.
 *
 * SRP: load / save / gate the iteration counter. No taxonomy logic.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RetuneState, Taxonomy } from "./types.js";

/** Number of unattended passes before human review is required. */
export const HALT_AFTER_ITERATIONS = Number(process.env.RETUNE_HALT_AFTER ?? 2);

function stateDir(repoPath: string): string {
  return join(repoPath, ".anatomia");
}
function statePath(repoPath: string): string {
  return join(stateDir(repoPath), "retune-state.json");
}

export async function loadState(repoPath: string, project: string): Promise<RetuneState> {
  try {
    const raw = await readFile(statePath(repoPath), "utf8");
    const parsed = JSON.parse(raw) as RetuneState;
    if (parsed && parsed.project === project && Array.isArray(parsed.history)) return parsed;
  } catch {
    /* no prior state */
  }
  return { version: 1, project, iterations: 0, history: [] };
}

export async function saveState(repoPath: string, state: RetuneState): Promise<void> {
  await mkdir(stateDir(repoPath), { recursive: true });
  await writeFile(statePath(repoPath), JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** Append a pass to the history and bump the counter. `at` is supplied by the caller. */
export function recordPass(state: RetuneState, taxonomy: Taxonomy, at?: string): RetuneState {
  const modules = taxonomy.domains.reduce((s, d) => s + d.modules.length, 0);
  return {
    ...state,
    iterations: state.iterations + 1,
    lastRunAt: at ?? state.lastRunAt,
    history: [
      ...state.history,
      {
        iteration: state.iterations + 1,
        domains: taxonomy.domains.length,
        modules,
        unassigned: taxonomy.unassigned?.count ?? 0,
      },
    ],
  };
}

/** True when the NEXT pass would exceed the unattended budget → require human review. */
export function shouldHaltForHuman(state: RetuneState): boolean {
  return state.iterations >= HALT_AFTER_ITERATIONS;
}
