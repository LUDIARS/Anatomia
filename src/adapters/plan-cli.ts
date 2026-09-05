/**
 * src/adapters/plan-cli.ts — `anatomia plan`.
 *
 * Turns a free-text task into the domain-sized work plan the author reads
 * BEFORE writing code (design §3.1): which declared domain each piece lands in,
 * what that domain already defines, what already exists, and what to imitate.
 *
 * `--project` is repeatable and analyses each registered project through the
 * ProjectManager (cache-aware); `--repo` analyses one unregistered checkout so
 * a repo that was never registered still gets a plan. Every covered repo gets
 * the plan written under its `.anatomia/plan/` so `verify --plan` can reconcile
 * the finished PR against it.
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
import { buildPlan, formatPlan, formatPlanOkf, savePlan, type PlanRepo } from "../supply/plan/index.js";
import type { CliArgs } from "./cli.js";

/**
 * Resolve the repos a plan covers.
 *
 * A registered project is analysed through the manager so the plan reuses the
 * warm cache instead of re-parsing the repo; an unregistered `--repo` path is
 * analysed directly and gets a slug id derived from its directory name.
 */
export async function resolvePlanRepos(args: CliArgs): Promise<PlanRepo[]> {
  const projectIds = args.projects ?? (args.project ? [args.project] : []);
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
    });
  }
  return repos;
}

/** Run `plan` and render it (Markdown by default, `--json`, or `--format okf`). */
export async function runPlan(args: CliArgs): Promise<{ exitCode: number; output: string }> {
  const task = args.task ?? "";
  const repos = await resolvePlanRepos(args);
  const plan = await buildPlan(task, repos, { noLlm: args.noLlm === true });

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
