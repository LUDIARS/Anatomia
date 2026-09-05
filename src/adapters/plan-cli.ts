/**
 * src/adapters/plan-cli.ts — `anatomia plan`.
 *
 * Turns a free-text task into the domain-sized work plan the author reads
 * BEFORE writing code (design §3.1): which declared domain each piece lands in,
 * what that domain already defines, what already exists, and what to imitate.
 *
 * `--project` is repeatable and analyses each registered project through the
 * ProjectManager (cache-aware); `--repo` analyses one unregistered checkout so
 * a repo that was never registered still gets a plan. When NEITHER is given the
 * cross-project domain map picks the projects from the task itself
 * (design §12.3, `--hints-from-map`, on by default, `--no-map` to opt out) —
 * that is the whole point of the map: 「切り絵のデモを実装する」 should not also
 * have to say "in Pictor and Figmentum".
 *
 * Every covered repo gets the plan written under its `.anatomia/plan/` so
 * `verify --plan` can reconcile the finished PR against it.
 *
 * The exit code is ALWAYS 0: a plan is a briefing, not a gate. An LLM that was
 * unavailable shows up as a note in the output, not as a failure.
 *
 * SRP: CLI shaping for `plan` only. The pipeline lives in src/supply/plan/.
 */

import { basename, resolve } from "node:path";
import { analyze } from "../core.js";
import { ProjectManager } from "../project/manager.js";
import { effectiveOntologyDir } from "../project/config-paths.js";
import { slug } from "../project/registry.js";
import {
  buildPlan,
  collectMapHints,
  formatPlan,
  formatPlanOkf,
  hasKnowledgeLog,
  resolveUxCriticalDomainNames,
  savePlan,
  type PlanMapHints,
  type PlanRepo,
} from "../supply/plan/index.js";
import { resolveMapSources } from "./map-cli.js";
import { detectScreens } from "../screens/index.js";
import { detectEntryPoints } from "../entrypoints/index.js";
import type { CliArgs } from "./cli.js";

/**
 * Resolve the repos a plan covers.
 *
 * A registered project is analysed through the manager so the plan reuses the
 * warm cache instead of re-parsing the repo; an unregistered `--repo` path is
 * analysed directly and gets a slug id derived from its directory name.
 */
export async function resolvePlanRepos(
  args: CliArgs,
  hintedProjects: string[] = [],
): Promise<PlanRepo[]> {
  const explicit = args.projects ?? (args.project ? [args.project] : []);
  const projectIds = explicit.length > 0 ? explicit : hintedProjects;
  if (projectIds.length === 0) {
    // Resolve first: `--repo .` would otherwise slug the literal "." into an
    // empty id, and the plan would name its items "/<domain>".
    const repoPath = resolve(args.repoPath);
    const ctx = await analyze(repoPath, { quiet: true });
    return [{ id: slug(basename(repoPath)) || "repo", repoPath, ctx }];
  }

  const mgr = await ProjectManager.load();
  const repos: PlanRepo[] = [];
  for (const requested of projectIds) {
    const id = mgr.resolveId(requested);
    const project = mgr.get(id)!;
    repos.push({
      id,
      repoPath: project.rootPath,
      ctx: await mgr.getContext(id),
      ontologyDir: effectiveOntologyDir(project),
      knowledgeWriteRoot: project.knowledgeWriteRoot,
    });
  }
  return repos;
}

/**
 * The map's contribution, or null when it was refused or unusable.
 *
 * A map failure never takes the plan down: the search is an accelerator, and a
 * registry whose repos cannot be read still deserves a plan for the repo the
 * caller is standing in. The reason is carried into the plan's notes.
 */
export async function resolveMapHints(
  args: CliArgs,
): Promise<{ hints: PlanMapHints | null; note: string | null }> {
  if (args.hintsFromMap === false) return { hints: null, note: null };
  const task = args.task ?? "";
  if (task.trim() === "") return { hints: null, note: null };
  try {
    const sources = await resolveMapSources({ ...args, repoExplicit: args.repoExplicit === true });
    if (sources.length === 0) return { hints: null, note: null };
    return { hints: await collectMapHints(task, sources), note: null };
  } catch (error) {
    return {
      hints: null,
      note: `ドメインマップ検索を実行できませんでした: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Run `plan` and render it (Markdown by default, `--json`, or `--format okf`). */
export async function runPlan(args: CliArgs): Promise<{ exitCode: number; output: string }> {
  const task = args.task ?? "";
  const { hints, note } = await resolveMapHints(args);
  const repos = await resolvePlanRepos(args, hints?.projects ?? []);
  // A-10: which detection domains a UX-critical business domain covers, per
  // repo. Resolved through approved `domain-owns-code`, never by name.
  const uxCriticalDomains: Record<string, string[]> = {};
  for (const repo of repos) {
    if (!await hasKnowledgeLog(repo.repoPath, repo.id, repo.knowledgeWriteRoot)) {
      uxCriticalDomains[repo.id] = [];
      continue;
    }
    const screens = await detectScreens(repo.ctx);
    const entries = await detectEntryPoints(repo.ctx, { screens });
    uxCriticalDomains[repo.id] = await resolveUxCriticalDomainNames({
      repoPath: repo.repoPath,
      projectId: repo.id,
      knowledgeWriteRoot: repo.knowledgeWriteRoot,
      detections: (repo.ctx.domains ?? []).map((detection) => ({
        domain: detection.domain,
        implementors: detection.implementors,
      })),
      surface: {
        entryCodeSymbolIds: entries.entries
          .filter((entry) => entry.classes.includes("screen"))
          .map((entry) => entry.id),
        screenFiles: screens.screens.map((screen) => screen.file),
      },
    });
  }
  const plan = await buildPlan(task, repos, {
    noLlm: args.noLlm === true,
    uxCriticalDomains,
    ...(hints ? { mapHints: hints } : {}),
  });
  if (note) plan.notes.push(note);

  const { failed } = await savePlan(
    plan,
    repos.map((repo) => ({ id: repo.id, repoPath: repo.repoPath })),
  );
  for (const failure of failed) {
    // Reported, not swallowed: without the file, `verify --plan` has nothing to
    // reconcile against, and the user must know that before the PR is opened.
    plan.notes.push(`plan を保存できませんでした (${failure.path}): ${failure.reason}`);
  }

  if (args.json) return { exitCode: 0, output: JSON.stringify(plan, null, 2) };
  if (args.planFormat === "okf") return { exitCode: 0, output: formatPlanOkf(plan) };
  return { exitCode: 0, output: formatPlan(plan) };
}
