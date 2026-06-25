/**
 * src/domains/retune/screens.ts — Fold the detected screen composition into the
 * domain taxonomy (the retune side of the screens/ layer).
 *
 * The screens/ layer detects WHAT screens exist + how they compose/navigate.
 * Re-tune turns that into ontology: a deterministic `screen-composition` domain
 * (one module per stack×kind, owning the screen files by path) so the screens
 * surface in the Domain View and feed supply/verify exactly like any other
 * generated domain. It also persists the full screen graph as a committed
 * artifact and renders a compact summary that grounds the step-1 LLM prompt so
 * the rest of the taxonomy is screen-aware.
 *
 * Dependency direction is one-way: retune → screens (screens never imports
 * retune). SRP: screen→taxonomy mapping + artifact persistence + prompt summary.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnalysisContext } from "../../core.js";
import { detectScreens } from "../../screens/index.js";
import type { ScreenGraph, ScreenNode } from "../../screens/index.js";
import type { DomainPlan, ModulePlan } from "./types.js";
import { kebab } from "./taxonomy-ops.js";

/** Stable kebab id for the generated screen domain. */
export const SCREEN_DOMAIN_NAME = "screen-composition";

/** Escape a string for use as a literal RegExp fragment (membership path). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the `screen-composition` DomainPlan from a screen graph — one module per
 * (stack, kind), each owning its screens' files by path. Returns null when no
 * screen owns a file (scene-only graphs contribute no code ownership).
 */
export function screensToDomainPlan(graph: ScreenGraph): DomainPlan | null {
  // Group file-backed screens by stack×kind.
  const groups = new Map<string, ScreenNode[]>();
  for (const s of graph.screens) {
    if (!s.file) continue; // scene-only screens own no code
    const key = `${s.stack}-${s.kind}`;
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }
  if (groups.size === 0) return null;

  const modules: ModulePlan[] = [];
  for (const [key, screens] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const paths = [...new Set(screens.map((s) => `${escapeRe(s.file)}$`))].sort();
    modules.push({
      name: kebab(`screens-${key}`),
      description: `${screens.length} ${key} 画面: ${screens
        .slice(0, 6)
        .map((s) => s.name)
        .join(", ")}${screens.length > 6 ? " …" : ""}`,
      paths,
    });
  }

  return {
    name: SCREEN_DOMAIN_NAME,
    description: `自動学習した画面構成（UI screens）: ${graph.summary.total} 画面 / ${graph.summary.edges} 構成・遷移エッジ。`,
    modules,
  };
}

/** A compact, deterministic screen summary for grounding the step-1 LLM prompt. */
export function summarizeScreens(graph: ScreenGraph, limit = 30): string[] {
  return graph.screens.slice(0, limit).map((s) => {
    const route = s.route ? ` ${s.route}` : "";
    const contains = s.contains.length ? ` contains:[${s.contains.join(", ")}]` : "";
    const nav = s.navigatesTo.length ? ` →[${s.navigatesTo.join(", ")}]` : "";
    return `- ${s.name} [${s.stack}/${s.kind}]${route}${contains}${nav}`;
  });
}

/** Write the screen graph as a committed artifact. Returns the repo-relative path. */
export async function persistScreenGraph(
  repoPath: string,
  project: string,
  graph: ScreenGraph,
): Promise<string> {
  await mkdir(join(repoPath, "spec", "data"), { recursive: true });
  const rel = `spec/data/${project}.screens.json`;
  await writeFile(join(repoPath, "spec", "data", `${project}.screens.json`), JSON.stringify(graph, null, 2) + "\n", "utf8");
  return rel;
}

/** Detect screens on a context and produce both the graph and its DomainPlan. */
export async function detectScreenPlan(
  ctx: AnalysisContext,
): Promise<{ graph: ScreenGraph; plan: DomainPlan | null }> {
  const graph = await detectScreens(ctx);
  return { graph, plan: screensToDomainPlan(graph) };
}
