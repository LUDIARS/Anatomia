/**
 * src/adapters/cli.ts -- T31 + multi-project: CLI gate adapter.
 *
 * Subcommands:
 *   verify        -- run the 5-gate verify pipeline; exit 1 if any block gate fails
 *   context       -- assemble a ContextBundle; exit 0
 *   where         -- resolve landing points; exit 0
 *   export-graph  -- export a self-contained interactive HTML graph; -o <file>
 *   project       -- registry management:
 *                      project add <name> <path>   register a project
 *                      project list                list registered projects
 *                      project remove <id>         remove a project
 *                      project analyze <id>        analyze a project (cache-aware)
 *   web           -- start the multi-project management panel HTTP server
 *                      --port <n>    TCP port (default 4200)
 *                      --home <dir>  Anatomia home dir (registry + cache location)
 *   cache-stats   -- aggregate the A-3 LLM-cache transcript into a hit-rate report
 *                      --log <path>  JSONL transcript (default $ANATOMIA_CACHE_LOG)
 *                      --json        machine-readable report
 *
 * `verify` / `context` / `where` / `export-graph` accept `--project <id>` to
 * target a registered project (the registered rootPath overrides --repo).
 * Without --project the legacy single-project behaviour (analyze the --repo /
 * cwd path) is preserved.
 *
 * SRP: CLI arg parsing + output formatting only. Analysis via core.ts; project
 * lifecycle via ProjectManager; HTML building via export.ts.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import {
  analyze,
  buildContextBundle,
  buildVerdict,
} from "../core.js";
import { resolveLanding } from "../supply/landing.js";
import { buildReview, formatReview } from "../review/index.js";
import { ProjectManager } from "../project/manager.js";
import { exportGraphHtml } from "./web/export.js";
import { startServer } from "./web/server.js";
import { readEvents } from "../cache/transcript.js";
import { aggregate, formatReport } from "../cache/stats.js";
import { estimateCost, formatCost } from "../cache/cost-estimate.js";
import { runIntegral } from "../integral/run.js";
import { emptySceneModel } from "../integral/scene.js";
import { evaluateModulesFromGraph } from "../modules/evaluate.js";
import { resolveProviders, envConfig } from "../providers/index.js";
import { resolveCacheStore } from "../cache/resolve.js";
import {
  domainsDir,
  loadEditableDomains,
  saveEditableDomains,
  synthesizeDomainDrafts,
  seedDraftsFromStructure,
  reconcileDrafts,
  type DomainDraft,
} from "../domains/authoring/index.js";
import type { IntegralQuery, IntegralReport } from "../integral/types.js";
import type { AnalysisContext } from "../core.js";
import type { Verdict } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectAction = "add" | "list" | "remove" | "analyze";
export type DomainsAction = "draft" | "list" | "reconstruct";

export interface CliArgs {
  subcommand:
    | "verify"
    | "context"
    | "where"
    | "review"
    | "project"
    | "export-graph"
    | "web"
    | "cache-stats"
    | "integral"
    | "domains";
  repoPath: string;
  /** For cache-stats: path to the JSONL transcript (defaults to ANATOMIA_CACHE_LOG). */
  logPath?: string;
  /** For verify: path to diff file, or "-" to read stdin. */
  diff?: string;
  /** For context/where. */
  task?: string;
  /** --json flag: output raw JSON without human summary. */
  json?: boolean;
  /** --project <id>: target a registered project. */
  project?: string;
  /** For export-graph: output file path. */
  output?: string;
  /** project subcommand details. */
  projectAction?: ProjectAction;
  /** positional args for the project subcommand (name/path/id). */
  projectArgs?: string[];
  /** For web: TCP port. Default 4200. */
  port?: number;
  /** For web: Anatomia home dir (registry + cache). */
  homeDir?: string;
  /** For integral: entry ref + scope + range + judge flag. */
  entry?: string;
  scope?: "function" | "domain" | "scene";
  climb?: "function" | "module" | "domain" | "scene" | "scene-adjacent";
  maxHops?: number;
  maxNodes?: number;
  judge?: boolean;
  /** For domains: action + options. */
  domainsAction?: DomainsAction;
  /** For domains draft/reconstruct: only these domain names (comma list). */
  only?: string[];
  /** For domains reconstruct: overwrite locked/manual defs. */
  force?: boolean;
  /** For domains draft: use the deterministic skeleton seed (no LLM). */
  noLlm?: boolean;
  /** For domains: explicit domains dir (default <repoRoot>/.anatomia/domains). */
  dir?: string;
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): CliArgs {
  const args = [...argv];

  const subcommand = args.shift();
  if (
    subcommand !== "verify" &&
    subcommand !== "context" &&
    subcommand !== "where" &&
    subcommand !== "review" &&
    subcommand !== "project" &&
    subcommand !== "export-graph" &&
    subcommand !== "web" &&
    subcommand !== "cache-stats" &&
    subcommand !== "integral" &&
    subcommand !== "domains"
  ) {
    throw new Error(
      `Unknown subcommand "${subcommand ?? ""}". Expected: verify | context | where | review | project | export-graph | web | cache-stats | integral | domains`,
    );
  }

  // The `project` subcommand has its own positional grammar.
  if (subcommand === "project") {
    return parseProjectArgs(args);
  }

  if (subcommand === "integral") {
    return parseIntegralArgs(args);
  }

  if (subcommand === "domains") {
    return parseDomainsArgs(args);
  }

  // The `web` subcommand has its own flag set.
  if (subcommand === "web") {
    return parseWebArgs(args);
  }

  // The `cache-stats` subcommand has its own flag set.
  if (subcommand === "cache-stats") {
    return parseCacheStatsArgs(args);
  }

  let repoPath = process.cwd();
  let diff: string | undefined;
  let task: string | undefined;
  let json = false;
  let project: string | undefined;
  let output: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--repo" || flag === "-r") {
      repoPath = args[++i] ?? repoPath;
    } else if (flag === "--diff" || flag === "-d") {
      diff = args[++i];
    } else if (flag === "--task" || flag === "-t") {
      task = args[++i];
    } else if (flag === "--json" || flag === "-j") {
      json = true;
    } else if (flag === "--project" || flag === "-p") {
      project = args[++i];
    } else if (flag === "--output" || flag === "-o") {
      output = args[++i];
    } else if (subcommand === "export-graph" && !flag.startsWith("-")) {
      // Positional: export-graph <project-id-or-path>
      // If it looks like a path (contains / or \) use it as repoPath,
      // otherwise treat as project id.
      if (flag.includes("/") || flag.includes("\\") || flag.startsWith(".")) {
        repoPath = resolvePath(flag);
      } else {
        project = flag;
      }
    }
  }

  return { subcommand, repoPath, diff, task, json, project, output };
}

function parseWebArgs(args: string[]): CliArgs {
  let port = 4200;
  let homeDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port") {
      port = parseInt(args[++i] ?? "4200", 10);
    } else if (a === "--home") {
      homeDir = args[++i];
    }
  }
  return {
    subcommand: "web",
    repoPath: process.cwd(),
    port,
    homeDir,
  };
}

function parseCacheStatsArgs(args: string[]): CliArgs {
  let json = false;
  let logPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json" || a === "-j") json = true;
    else if (a === "--log" || a === "-l") logPath = args[++i];
  }
  return { subcommand: "cache-stats", repoPath: process.cwd(), json, logPath };
}

function parseProjectArgs(args: string[]): CliArgs {
  const action = args.shift();
  if (action !== "add" && action !== "list" && action !== "remove" && action !== "analyze") {
    throw new Error(
      `Unknown project action "${action ?? ""}". Expected: add | list | remove | analyze`,
    );
  }

  let json = false;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json" || a === "-j") json = true;
    else positionals.push(a);
  }

  return {
    subcommand: "project",
    repoPath: process.cwd(),
    json,
    projectAction: action,
    projectArgs: positionals,
  };
}

function parseIntegralArgs(args: string[]): CliArgs {
  let repoPath = process.cwd();
  let project: string | undefined;
  let entry: string | undefined;
  let scope: CliArgs["scope"] = "function";
  let climb: CliArgs["climb"];
  let maxHops: number | undefined;
  let maxNodes: number | undefined;
  let judge = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--repo" || a === "-r") repoPath = args[++i] ?? repoPath;
    else if (a === "--project" || a === "-p") project = args[++i];
    else if (a === "--entry" || a === "-e") entry = args[++i];
    else if (a === "--scope" || a === "-s") scope = args[++i] as CliArgs["scope"];
    else if (a === "--climb") climb = args[++i] as CliArgs["climb"];
    else if (a === "--max-hops") maxHops = parseInt(args[++i] ?? "", 10);
    else if (a === "--max-nodes") maxNodes = parseInt(args[++i] ?? "", 10);
    else if (a === "--judge") judge = true;
    else if (a === "--json" || a === "-j") json = true;
  }
  return { subcommand: "integral", repoPath, project, entry, scope, climb, maxHops, maxNodes, judge, json };
}

function parseDomainsArgs(args: string[]): CliArgs {
  const action = args.shift();
  if (action !== "draft" && action !== "list" && action !== "reconstruct") {
    throw new Error(`Unknown domains action "${action ?? ""}". Expected: draft | list | reconstruct`);
  }
  let repoPath = process.cwd();
  let project: string | undefined;
  let dir: string | undefined;
  let only: string[] | undefined;
  let force = false;
  let noLlm = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--repo" || a === "-r") repoPath = args[++i] ?? repoPath;
    else if (a === "--project" || a === "-p") project = args[++i];
    else if (a === "--dir") dir = args[++i];
    else if (a === "--only") only = (args[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--force") force = true;
    else if (a === "--no-llm") noLlm = true;
    else if (a === "--json" || a === "-j") json = true;
  }
  return { subcommand: "domains", repoPath, project, domainsAction: action, dir, only, force, noLlm, json };
}

// ---------------------------------------------------------------------------
// Human summary for verify
// ---------------------------------------------------------------------------

function formatVerdict(verdict: Verdict): string {
  const lines: string[] = [];
  lines.push(verdict.pass ? "PASS" : "FAIL");
  for (const gate of verdict.gates) {
    const status = gate.pass ? "PASS" : "FAIL";
    lines.push(`  [${status}] ${gate.gate}${gate.suggestion ? ` -- ${gate.suggestion}` : ""}`);
  }
  if (verdict.suggestion) {
    lines.push("");
    lines.push(verdict.suggestion);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// runCli
// ---------------------------------------------------------------------------

export async function runCli(
  args: CliArgs,
): Promise<{ exitCode: number; output: string }> {
  if (args.subcommand === "project") {
    return runProject(args);
  }

  if (args.subcommand === "cache-stats") {
    return runCacheStats(args);
  }

  if (args.subcommand === "integral") {
    return runIntegralCli(args);
  }

  if (args.subcommand === "domains") {
    return runDomains(args);
  }

  const ctx = await resolveContext(args);

  if (args.subcommand === "verify") {
    let diffSource = "";
    const diffArg = args.diff ?? "-";
    if (diffArg === "-") {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      diffSource = Buffer.concat(chunks).toString("utf8");
    } else {
      diffSource = await readFile(diffArg, "utf8");
    }

    const verdict = await buildVerdict(ctx, diffSource);
    const exitCode = verdict.pass ? 0 : 1;

    if (args.json) {
      return { exitCode, output: JSON.stringify(verdict, null, 2) };
    }
    return { exitCode, output: formatVerdict(verdict) };
  }

  if (args.subcommand === "context") {
    const task = args.task ?? "analyze";
    const bundle = await buildContextBundle(ctx, { task });
    return { exitCode: 0, output: JSON.stringify(bundle, null, 2) };
  }

  if (args.subcommand === "where") {
    const task = args.task ?? "analyze";
    const stubDetector = async () => ["general"];
    const stubLayerRules = { layerFor: () => null };
    const stubSiblings = async () => [];
    const landings = await resolveLanding(
      { description: task },
      stubDetector,
      stubLayerRules,
      stubSiblings,
    );
    return { exitCode: 0, output: JSON.stringify({ landings }, null, 2) };
  }

  if (args.subcommand === "review") {
    const report = await buildReview(ctx);
    if (args.json) {
      return { exitCode: 0, output: JSON.stringify(report, null, 2) };
    }
    return { exitCode: 0, output: formatReview(report) };
  }

  if (args.subcommand === "export-graph") {
    const outputPath = args.output ?? "graph.html";
    const html = await exportGraphHtml(ctx, { title: undefined });
    await writeFile(outputPath, html, "utf8");
    const nodeCount = ctx.functions.length;
    return {
      exitCode: 0,
      output: `exported graph to ${outputPath} (${ctx.files.length} files, ${nodeCount} functions)`,
    };
  }

  return { exitCode: 1, output: "Unknown subcommand" };
}

/**
 * Resolve the AnalysisContext for verify/context/where. With --project, analyze
 * the registered project (cache-aware) via the persisted ProjectManager;
 * otherwise analyze the --repo / cwd path directly (legacy behaviour).
 */
async function resolveContext(args: CliArgs): Promise<AnalysisContext> {
  if (args.project) {
    const mgr = await ProjectManager.load();
    return mgr.getContext(args.project);
  }
  return analyze(args.repoPath);
}

// ---------------------------------------------------------------------------
// cache-stats subcommand — aggregate the A-3 cache transcript into a hit rate
// ---------------------------------------------------------------------------

/**
 * Report the LLM-cache hit rate from the JSONL transcript written when
 * ANATOMIA_CACHE_LOG is set (see cache/transcript.ts). Reads --log <path> or the
 * env var; aggregates global / per-namespace / per-session hit rates + token
 * spend. This is how a session quantifies whether the shared cache is paying off.
 */
async function runCacheStats(
  args: CliArgs,
): Promise<{ exitCode: number; output: string }> {
  const logPath = args.logPath ?? process.env["ANATOMIA_CACHE_LOG"];
  if (!logPath) {
    return {
      exitCode: 1,
      output:
        "no transcript: set ANATOMIA_CACHE_LOG (and run verify/analyze via MCP) " +
        "or pass --log <path.jsonl>",
    };
  }
  const events = await readEvents(logPath);
  const report = aggregate(events);
  const cost = estimateCost(report);
  if (args.json) {
    return { exitCode: 0, output: JSON.stringify({ ...report, cost }, null, 2) };
  }
  const text = cost ? `${formatReport(report)}\n\n${formatCost(cost)}` : formatReport(report);
  return { exitCode: 0, output: text };
}

// ---------------------------------------------------------------------------
// project subcommand
// ---------------------------------------------------------------------------

async function runProject(
  args: CliArgs,
): Promise<{ exitCode: number; output: string }> {
  const mgr = await ProjectManager.load();
  const pos = args.projectArgs ?? [];

  switch (args.projectAction) {
    case "add": {
      const [name, path] = pos;
      if (!name || !path) {
        return { exitCode: 1, output: "usage: anatomia project add <name> <path>" };
      }
      const project = await mgr.addProject({ name, rootPath: resolvePath(path) });
      if (args.json) return { exitCode: 0, output: JSON.stringify(project, null, 2) };
      return { exitCode: 0, output: `added project "${project.id}" -> ${project.rootPath}` };
    }

    case "list": {
      const projects = mgr.list();
      if (args.json) {
        return { exitCode: 0, output: JSON.stringify({ projects, selected: mgr.selected }, null, 2) };
      }
      if (projects.length === 0) return { exitCode: 0, output: "(no projects registered)" };
      const lines = projects.map(
        (p) => `${p.id === mgr.selected ? "*" : " "} ${p.id}\t${p.name}\t${p.rootPath}`,
      );
      return { exitCode: 0, output: lines.join("\n") };
    }

    case "remove": {
      const [id] = pos;
      if (!id) return { exitCode: 1, output: "usage: anatomia project remove <id>" };
      const ok = await mgr.removeProject(id);
      if (args.json) return { exitCode: ok ? 0 : 1, output: JSON.stringify({ removed: ok, id }) };
      return ok
        ? { exitCode: 0, output: `removed project "${id}"` }
        : { exitCode: 1, output: `no such project "${id}"` };
    }

    case "analyze": {
      const [id] = pos;
      let targetId: string;
      try {
        targetId = mgr.resolveId(id);
      } catch (err) {
        return { exitCode: 1, output: err instanceof Error ? err.message : String(err) };
      }
      const before = mgr.cache.hits;
      const ctx = await mgr.analyzeProject(targetId);
      const cacheHit = mgr.cache.hits > before;
      const result = {
        project: targetId,
        files: ctx.files.length,
        functions: ctx.functions.length,
        cacheHit,
      };
      if (args.json) return { exitCode: 0, output: JSON.stringify(result, null, 2) };
      return {
        exitCode: 0,
        output: `analyzed "${targetId}": ${result.files} files, ${result.functions} functions${cacheHit ? " (cache hit)" : ""}`,
      };
    }

    default:
      return { exitCode: 1, output: "Unknown project action" };
  }
}

// ---------------------------------------------------------------------------
// integral subcommand — 3-layer scoped retrieval (integral search)
// ---------------------------------------------------------------------------

async function runIntegralCli(args: CliArgs): Promise<{ exitCode: number; output: string }> {
  if (!args.entry) {
    return { exitCode: 1, output: "usage: anatomia integral --entry <ref> [--scope function|domain|scene] [--judge]" };
  }
  let ctx: AnalysisContext;
  let fingerprint = "nofp";
  if (args.project) {
    const mgr = await ProjectManager.load();
    ctx = await mgr.getContext(args.project);
    fingerprint = await mgr.fingerprint(args.project);
  } else {
    ctx = await analyze(args.repoPath);
  }

  const { evaluation } = await evaluateModulesFromGraph(ctx.graph, ctx.functions);
  const query: IntegralQuery = {
    entry: { ref: args.entry, scope: args.scope ?? "function" },
    range: {
      climb: args.climb,
      maxHops: args.maxHops,
      maxNodes: args.maxNodes,
    },
  };

  // The judge runs the Sonnet agent inside Anatomia; only wired when --judge.
  let llm; let modelId;
  if (args.judge) {
    const judgeModel = process.env["ANATOMIA_INTEGRAL_JUDGE_MODEL"] || "claude-sonnet-4-6";
    const providers = resolveProviders({ ...envConfig(), llmModel: judgeModel });
    llm = providers.llm;
    modelId = providers.llmModelId;
  }

  const report = await runIntegral(ctx, query, {
    scenes: emptySceneModel(),
    moduleEval: evaluation,
    fingerprint,
    llm,
    modelId,
    cache: args.judge ? resolveCacheStore() : undefined,
  });

  if (args.json) return { exitCode: 0, output: JSON.stringify(report, null, 2) };
  return { exitCode: 0, output: formatIntegral(report) };
}

function formatIntegral(report: IntegralReport): string {
  const r = report.result;
  const lines: string[] = [];
  lines.push(`integral search — entry=${r.query.entry.ref} scope=${r.query.entry.scope}`);
  lines.push(`  seeds: ${r.seeds.length}  anchors: ${r.anchors.length}  modules: ${r.modules.length}  domains: ${r.domains.length}  scenes: ${r.scenes.length}`);
  lines.push(`  elapsed ${r.elapsedMs}ms${r.truncated ? ` (truncated: ${r.stopReason})` : ""}`);
  if (r.modules.length) {
    lines.push("  機能(modules):");
    for (const m of r.modules.slice(0, 12)) {
      const coh = m.cohesion == null ? "n/a" : `${Math.round(m.cohesion * 100)}%`;
      lines.push(`    - ${m.label} (${m.anchors.length} fn, 凝集 ${coh})${m.isHome ? " [home]" : ""}`);
    }
  }
  if (r.domains.length) {
    lines.push("  domains: " + r.domains.map((d) => `${d.name}[${d.via}]`).join(", "));
  }
  if (report.decision) {
    lines.push("");
    lines.push(`judge: sufficientScope=${report.decision.sufficientScope} confidence=${report.decision.confidence}${report.cached ? " (cached)" : ""}`);
    lines.push(`  ${report.decision.reason}`);
    if (report.decision.answer) lines.push(`  answer: ${report.decision.answer}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// domains subcommand — spec-seeded, human-editable domain authoring
// ---------------------------------------------------------------------------

async function runDomains(args: CliArgs): Promise<{ exitCode: number; output: string }> {
  // Resolve the repo root + domains dir + (optional) project for ontologyDir wiring.
  let repoRoot = args.repoPath;
  let mgr: ProjectManager | undefined;
  let projectId: string | undefined;
  if (args.project) {
    mgr = await ProjectManager.load();
    projectId = mgr.resolveId(args.project);
    repoRoot = mgr.get(projectId)!.rootPath;
  }
  const dir = args.dir ?? domainsDir(repoRoot);

  if (args.domainsAction === "list") {
    const defs = await loadEditableDomains(dir);
    if (args.json) return { exitCode: 0, output: JSON.stringify({ dir, domains: defs }, null, 2) };
    if (!defs.length) return { exitCode: 0, output: `(no editable domains in ${dir})` };
    const lines = defs.map(
      (d) => `${d.name}\t[${d.source}]\t${d.presetRules.length} rules${d.mechanics?.length ? `\tmech: ${d.mechanics.join(",")}` : ""}`,
    );
    return { exitCode: 0, output: lines.join("\n") };
  }

  // draft / reconstruct: analyze → synthesise → reconcile → save.
  const ctx = args.project
    ? await mgr!.getContext(projectId)
    : await analyze(repoRoot);
  const inputs = {
    specClauses: ctx.specClauses ?? [],
    filePaths: ctx.files.map((f) => f.path),
  };

  let drafts: DomainDraft[];
  if (args.noLlm) {
    drafts = seedDraftsFromStructure(inputs);
  } else {
    const providers = resolveProviders();
    const cache = resolveCacheStore<DomainDraft[]>();
    drafts = await synthesizeDomainDrafts(inputs, providers.llm, cache, providers.llmModelId);
  }
  if (args.only && args.only.length) {
    const want = new Set(args.only);
    drafts = drafts.filter((d) => want.has(d.name));
  }

  const existing = await loadEditableDomains(dir);
  const result = reconcileDrafts(existing, drafts, { force: args.force });
  await saveEditableDomains(dir, result.merged);

  // Wire the project's ontologyDir to the domains dir so detection loads them.
  if (mgr && projectId && !mgr.get(projectId)!.ontologyDir) {
    const proj = mgr.get(projectId)!;
    (proj as { ontologyDir?: string }).ontologyDir = dir;
    await mgr.save();
  }

  if (args.json) {
    return { exitCode: 0, output: JSON.stringify({ dir, ...summarizeReconcile(result) }, null, 2) };
  }
  const s = summarizeReconcile(result);
  return {
    exitCode: 0,
    output:
      `domains ${args.domainsAction} → ${dir}\n` +
      `  drafted: ${drafts.length}  added: ${s.added.length}  updated: ${s.updated.length}  preserved: ${s.preserved.length}\n` +
      (s.added.length ? `  + ${s.added.join(", ")}\n` : "") +
      (s.updated.length ? `  ~ ${s.updated.join(", ")}\n` : "") +
      `  total on disk: ${result.merged.length}`,
  };
}

function summarizeReconcile(r: ReturnType<typeof reconcileDrafts>): {
  added: string[];
  updated: string[];
  preserved: string[];
} {
  return { added: r.added, updated: r.updated, preserved: r.preserved };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * Write `text` to a stdio stream, wait for it to flush, then exit with `code`.
 *
 * On Windows, stdout/stderr backed by a pipe (a hook redirect, a backfill loop
 * capturing output) are *asynchronous*: write() hands the data to libuv and
 * returns before the OS pipe has drained. Calling process.exit() immediately
 * tears down the pipe handle while that write is still closing, which makes
 * libuv abort with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` —
 * intermittently, only when the write happens to still be in flight. Waiting
 * for the write callback (fired once the data is flushed) before exiting closes
 * the race and also guarantees the output is never truncated.
 */
async function writeThenExit(
  stream: NodeJS.WriteStream,
  text: string,
  code: number,
): Promise<never> {
  await new Promise<void>((resolve) => stream.write(text, () => resolve()));
  process.exit(code);
}

export async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeThenExit(process.stderr, `anatomia: ${msg}\n`, 1);
    return;
  }

  // The `web` subcommand starts an HTTP server and keeps the process alive.
  // We handle it here before runCli() so we never call process.exit().
  if (args.subcommand === "web") {
    const mgr = await ProjectManager.load({ homeDir: args.homeDir });
    await startServer({ ctx: mgr, port: args.port ?? 4200 });
    // startServer starts the Hono listener; the event loop keeps the process alive.
    return;
  }

  const { exitCode, output } = await runCli(args);
  await writeThenExit(process.stdout, output + "\n", exitCode);
}