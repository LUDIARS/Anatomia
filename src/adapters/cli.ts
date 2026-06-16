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
import { ProjectManager } from "../project/manager.js";
import { exportGraphHtml } from "./web/export.js";
import { startServer } from "./web/server.js";
import { readEvents } from "../cache/transcript.js";
import { aggregate, formatReport } from "../cache/stats.js";
import type { AnalysisContext } from "../core.js";
import type { Verdict } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectAction = "add" | "list" | "remove" | "analyze";

export interface CliArgs {
  subcommand: "verify" | "context" | "where" | "project" | "export-graph" | "web" | "cache-stats";
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
    subcommand !== "project" &&
    subcommand !== "export-graph" &&
    subcommand !== "web" &&
    subcommand !== "cache-stats"
  ) {
    throw new Error(
      `Unknown subcommand "${subcommand ?? ""}". Expected: verify | context | where | project | export-graph | web | cache-stats`,
    );
  }

  // The `project` subcommand has its own positional grammar.
  if (subcommand === "project") {
    return parseProjectArgs(args);
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
  if (args.json) {
    return { exitCode: 0, output: JSON.stringify(report, null, 2) };
  }
  return { exitCode: 0, output: formatReport(report) };
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
// main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`anatomia: ${msg}\n`);
    process.exit(1);
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
  process.stdout.write(output + "\n");
  process.exit(exitCode);
}