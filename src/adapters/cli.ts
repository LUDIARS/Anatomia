/**
 * src/adapters/cli.ts -- T31 + multi-project: CLI gate adapter.
 *
 * Subcommands:
 *   verify        -- run the 5-gate verify pipeline; exit 1 if any block gate fails
 *   context       -- assemble a ContextBundle; exit 0
 *   where         -- resolve landing points; exit 0
 *   find          -- find function symbols by name; exit 0
 *   callers       -- list callers of a function symbol/anchor; exit 0
 *   callees       -- list callees of a function symbol/anchor; exit 0
 *   spec-review   -- review spec/ against AIFormat criteria; exit 0
 *   domain-review -- deterministic per-domain review (coverage / cohesion /
 *                      drift / overlap / spec integrity); exit 0
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
 *   links         -- code↔spec link hardening loop:
 *                      links list [--project <id>]              list current links
 *                      links ratify <from> <to> [--project <id>] ratify + persist a link
 *                      links candidates [--project <id>]        stable links proposed for promotion
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
import { basename, resolve as resolvePath } from "node:path";
import {
  analyze,
  buildContextBundle,
  buildVerdict,
} from "../core.js";
import { resolveLanding } from "../supply/landing.js";
import { landingInjections } from "../supply/detectors.js";
import {
  buildSymbolIndex,
  callersOf,
  calleesOf,
  findSymbol,
  type SymbolHit,
  type SymbolLookupOptions,
} from "../graph/index.js";
import {
  buildReview,
  formatReview,
  loadBaseline,
  saveBaseline,
  applyBaseline,
  buildDomainReview,
  formatDomainReview,
} from "../review/index.js";
import { ratifyLink, SpecLinkRatifyError } from "../spec/ratify.js";
import {
  loadStability,
  recordAnalysis,
  promotionCandidates,
  promoteStreakThreshold,
} from "../spec/stability.js";
import { computeFingerprint } from "../project/cache.js";
import { reviewSpec, formatSpecReview } from "../spec-review/index.js";
import { detectScreens } from "../screens/index.js";
import type { ScreenGraph } from "../screens/index.js";
import { deriveScenes, type DerivedSceneGraph } from "../scenes/derive.js";
import { loadScenes, mergeSceneModel } from "../scenes/store.js";
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
import { generateCppHeader, generateCppPatches, type DomainEntryPoint } from "../dynamic/inject-cpp.js";
import { generateCSharpStub, generateCSharpPatches } from "../dynamic/inject-csharp.js";
import { sceneModelFromTraceFile } from "../dynamic/record/ingest.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { IntegralQuery, IntegralReport } from "../integral/types.js";
import type { AnalysisContext } from "../core.js";
import type { AnchorId, Verdict } from "../types.js";
import {
  initVestigium,
  installCrashLogging,
  vgCrash,
  vgShutdown,
  vgWrite,
  withVgSpan,
} from "../obs/vestigium.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectAction = "add" | "list" | "remove" | "analyze";
export type DomainsAction = "draft" | "list" | "reconstruct" | "suggest";
export type TraceAction = "plan" | "ingest";
export type LinksAction = "list" | "ratify" | "candidates";

export interface CliArgs {
  subcommand:
    | "verify"
    | "context"
    | "where"
    | "find"
    | "callers"
    | "callees"
    | "review"
    | "spec-review"
    | "domain-review"
    | "project"
    | "export-graph"
    | "web"
    | "cache-stats"
    | "integral"
    | "domains"
    | "trace"
    | "screens"
    | "scenes"
    | "links";
  repoPath: string;
  /** For cache-stats: path to the JSONL transcript (defaults to ANATOMIA_CACHE_LOG). */
  logPath?: string;
  /** For verify: path to diff file, or "-" to read stdin. */
  diff?: string;
  /** For verify: the changed file's repo-relative path, used to attribute the
   *  diff's new functions to a layer so `by:path` rules apply. Defaults to the
   *  first `+++ b/<path>` parsed from the diff. */
  file?: string;
  /** For context/where. */
  task?: string;
  /** For find/callers/callees. */
  symbol?: string;
  /** For find. */
  mode?: SymbolLookupOptions["mode"];
  /** For find/callers/callees. */
  limit?: number;
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
  /** For trace: action (plan | ingest). */
  traceAction?: TraceAction;
  /** For trace plan: output dir for the generated header. */
  traceOut?: string;
  /** For trace ingest: recorded JSONL trace file path. */
  traceFile?: string;
  /** For trace plan: instrumentation language (default cpp). */
  traceLang?: "cpp" | "csharp";
  /** For review: path to baseline JSON; acknowledged findings are suppressed. */
  baselinePath?: string;
  /** For review: write the current report as a new baseline file (no output). */
  writeBaseline?: string;
  /** For links: action (list | ratify). */
  linksAction?: LinksAction;
  /** For links ratify: code anchor / file path (`from` side). */
  linkFrom?: string;
  /** For links ratify: spec clause id (`to` side). */
  linkTo?: string;
  /** For project analyze: repo-relative path prefixes for a partial run. */
  scopePaths?: string[];
  /** For project analyze: skip Phase 4 (domain detection). */
  noDomains?: boolean;
  /** For project analyze: skip Phase 5 (spec linking). */
  noSpec?: boolean;
  /** For scenes: reachability depth cap over `calls` edges. */
  sceneMaxDepth?: number;
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
    subcommand !== "find" &&
    subcommand !== "callers" &&
    subcommand !== "callees" &&
    subcommand !== "review" &&
    subcommand !== "spec-review" &&
    subcommand !== "domain-review" &&
    subcommand !== "project" &&
    subcommand !== "export-graph" &&
    subcommand !== "web" &&
    subcommand !== "cache-stats" &&
    subcommand !== "integral" &&
    subcommand !== "domains" &&
    subcommand !== "trace" &&
    subcommand !== "screens" &&
    subcommand !== "scenes" &&
    subcommand !== "links"
  ) {
    throw new Error(
      `Unknown subcommand "${subcommand ?? ""}". Expected: verify | context | where | find | callers | callees | review | spec-review | domain-review | project | export-graph | web | cache-stats | integral | domains | trace | screens | scenes | links`,
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

  if (subcommand === "trace") {
    return parseTraceArgs(args);
  }

  if (subcommand === "links") {
    return parseLinksArgs(args);
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
  let file: string | undefined;
  let task: string | undefined;
  let symbol: string | undefined;
  let mode: SymbolLookupOptions["mode"] | undefined;
  let limit: number | undefined;
  let json = false;
  let project: string | undefined;
  let output: string | undefined;
  let baselinePath: string | undefined;
  let writeBaseline: string | undefined;
  let sceneMaxDepth: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--repo" || flag === "-r") {
      repoPath = args[++i] ?? repoPath;
    } else if (flag === "--diff" || flag === "-d") {
      diff = args[++i];
    } else if (flag === "--file" || flag === "-f") {
      file = args[++i];
    } else if (flag === "--task" || flag === "-t") {
      task = args[++i];
    } else if (flag === "--mode") {
      const value = args[++i] as SymbolLookupOptions["mode"] | undefined;
      if (value !== "exact" && value !== "prefix" && value !== "substring") {
        throw new Error(`Invalid --mode "${value ?? ""}". Expected: exact | prefix | substring`);
      }
      mode = value;
    } else if (flag === "--limit") {
      limit = parseInt(args[++i] ?? "", 10);
    } else if (flag === "--max-depth") {
      sceneMaxDepth = parseInt(args[++i] ?? "", 10);
      if (!Number.isFinite(sceneMaxDepth) || sceneMaxDepth < 1) {
        throw new Error("--max-depth expects a positive integer");
      }
    } else if (flag === "--json" || flag === "-j") {
      json = true;
    } else if (flag === "--project" || flag === "-p") {
      project = args[++i];
    } else if (flag === "--output" || flag === "-o") {
      output = args[++i];
    } else if (flag === "--baseline") {
      baselinePath = args[++i];
    } else if (flag === "--write-baseline") {
      writeBaseline = args[++i];
    } else if (subcommand === "export-graph" && !flag.startsWith("-")) {
      // Positional: export-graph <project-id-or-path>
      // If it looks like a path (contains / or \) use it as repoPath,
      // otherwise treat as project id.
      if (flag.includes("/") || flag.includes("\\") || flag.startsWith(".")) {
        repoPath = resolvePath(flag);
      } else {
        project = flag;
      }
    } else if (
      (subcommand === "find" || subcommand === "callers" || subcommand === "callees") &&
      !flag.startsWith("-") &&
      !symbol
    ) {
      symbol = flag;
    }
  }

  return { subcommand, repoPath, diff, file, task, symbol, mode, limit, json, project, output, baselinePath, writeBaseline, sceneMaxDepth };
}

/**
 * Pull the changed file path(s) out of a unified diff's `+++ b/<path>` headers.
 * Returns the de-duplicated list in order of appearance. `/dev/null` (deletions)
 * is skipped. Used to attribute a diff to a layer so `by:path` rules apply.
 */
export function diffTargetPaths(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    if (!line.startsWith("+++ ")) continue;
    let p = line.slice(4).trim();
    if (p === "/dev/null") continue;
    p = p.replace(/^b\//, "").replace(/\t.*$/, "");
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
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
  let noDomains = false;
  let noSpec = false;
  const scopePaths: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json" || a === "-j") json = true;
    else if (a === "--path") {
      const p = args[++i];
      if (!p) throw new Error("--path expects a repo-relative path prefix");
      scopePaths.push(p);
    } else if (a === "--no-domains") noDomains = true;
    else if (a === "--no-spec") noSpec = true;
    else positionals.push(a);
  }
  if ((scopePaths.length > 0 || noDomains || noSpec) && action !== "analyze") {
    throw new Error("--path / --no-domains / --no-spec only apply to `project analyze`");
  }

  return {
    subcommand: "project",
    repoPath: process.cwd(),
    json,
    projectAction: action,
    projectArgs: positionals,
    ...(scopePaths.length > 0 ? { scopePaths } : {}),
    ...(noDomains ? { noDomains } : {}),
    ...(noSpec ? { noSpec } : {}),
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
  if (action !== "draft" && action !== "list" && action !== "reconstruct" && action !== "suggest") {
    throw new Error(`Unknown domains action "${action ?? ""}". Expected: draft | list | reconstruct | suggest`);
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

function parseTraceArgs(args: string[]): CliArgs {
  const action = args.shift();
  if (action !== "plan" && action !== "ingest") {
    throw new Error(`Unknown trace action "${action ?? ""}". Expected: plan | ingest`);
  }
  let repoPath = process.cwd();
  let project: string | undefined;
  let traceOut: string | undefined;
  let traceFile: string | undefined;
  let entry: string | undefined;
  let scope: CliArgs["scope"] = "function";
  let json = false;
  let traceLang: CliArgs["traceLang"];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--repo" || a === "-r") repoPath = args[++i] ?? repoPath;
    else if (a === "--project" || a === "-p") project = args[++i];
    else if (a === "--out") traceOut = args[++i];
    else if (a === "--file" || a === "-f") traceFile = args[++i];
    else if (a === "--entry" || a === "-e") entry = args[++i];
    else if (a === "--scope" || a === "-s") scope = args[++i] as CliArgs["scope"];
    else if (a === "--lang") {
      const value = args[++i];
      if (value !== "cpp" && value !== "csharp") {
        throw new Error(`Invalid --lang "${value ?? ""}". Expected: cpp | csharp`);
      }
      traceLang = value;
    } else if (a === "--json" || a === "-j") json = true;
  }
  return { subcommand: "trace", repoPath, project, traceAction: action, traceOut, traceFile, entry, scope, json, traceLang };
}

function parseLinksArgs(args: string[]): CliArgs {
  const action = args.shift();
  if (action !== "list" && action !== "ratify" && action !== "candidates") {
    throw new Error(`Unknown links action "${action ?? ""}". Expected: list | ratify | candidates`);
  }
  let repoPath = process.cwd();
  let project: string | undefined;
  let json = false;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--repo" || a === "-r") repoPath = args[++i] ?? repoPath;
    else if (a === "--project" || a === "-p") project = args[++i];
    else if (a === "--json" || a === "-j") json = true;
    else positionals.push(a);
  }
  return {
    subcommand: "links",
    repoPath,
    project,
    json,
    linksAction: action,
    linkFrom: positionals[0],
    linkTo: positionals[1],
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

  if (args.subcommand === "integral") {
    return runIntegralCli(args);
  }

  if (args.subcommand === "domains") {
    return runDomains(args);
  }

  if (args.subcommand === "trace") {
    return runTrace(args);
  }

  if (args.subcommand === "links") {
    return runLinks(args);
  }

  if (args.subcommand === "spec-review") {
    const report = await reviewSpec(args.repoPath);
    if (args.json) return { exitCode: 0, output: JSON.stringify(report, null, 2) };
    return { exitCode: 0, output: formatSpecReview(report) };
  }

  if (args.subcommand === "domain-review") {
    return runDomainReview(args);
  }

  if (args.subcommand === "scenes") {
    return runScenes(args);
  }

  const ctx = await resolveContext(args);

  if (args.subcommand === "find") {
    if (!args.symbol) throw new Error("find requires a symbol name.");
    const hits = await findSymbol(
      buildSymbolIndex(ctx.functions),
      ctx.graph,
      args.symbol,
      { mode: args.mode, limit: args.limit },
    );
    if (args.json) return { exitCode: 0, output: JSON.stringify({ hits }, null, 2) };
    return { exitCode: 0, output: formatSymbolHits(hits) };
  }

  if (args.subcommand === "callers" || args.subcommand === "callees") {
    if (!args.symbol) throw new Error(`${args.subcommand} requires a symbol name or anchor.`);
    const hits =
      args.subcommand === "callers"
        ? await callersOf(ctx, ctx.graph, args.symbol, args.limit)
        : await calleesOf(ctx, ctx.graph, args.symbol, args.limit);
    if (args.json) return { exitCode: 0, output: JSON.stringify({ hits }, null, 2) };
    return { exitCode: 0, output: formatSymbolHits(hits) };
  }

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

    const verdict = await buildVerdict(ctx, diffSource, args.file);
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
    const injections = landingInjections(ctx);
    const landings = await resolveLanding(
      { description: task },
      injections.detector,
      injections.layerRules,
      injections.siblings,
    );
    return { exitCode: 0, output: JSON.stringify({ landings }, null, 2) };
  }

  if (args.subcommand === "review") {
    let report = await buildReview(ctx);
    if (args.writeBaseline) {
      await saveBaseline(args.writeBaseline, report);
      return { exitCode: 0, output: `baseline written to ${args.writeBaseline}` };
    }
    if (args.baselinePath) {
      const baseline = await loadBaseline(args.baselinePath);
      report = applyBaseline(report, baseline);
    }
    if (args.json) {
      return { exitCode: 0, output: JSON.stringify(report, null, 2) };
    }
    return { exitCode: 0, output: formatReview(report) };
  }

  if (args.subcommand === "screens") {
    const graph = await detectScreens(ctx);
    if (args.json) {
      return { exitCode: 0, output: JSON.stringify(graph, null, 2) };
    }
    return { exitCode: 0, output: formatScreens(graph) };
  }

  if (args.subcommand === "export-graph") {
    const outputPath = args.output ?? "graph.html";
    const html = await exportGraphHtml(ctx, { title: undefined });
    await writeFile(outputPath, html, "utf8");
    const nodeCount = ctx.functions.length;
    const unresolvedCount = ctx.graph.raw.unresolved?.length ?? 0;
    return {
      exitCode: 0,
      output:
        `exported graph to ${outputPath} (${ctx.files.length} files, ` +
        `${nodeCount} functions, ${unresolvedCount} unresolved calls)`,
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

/**
 * domain-review subcommand. Resolves the context like resolveContext, but also
 * needs the project's ontology dir so the editable defs (which carry specRefs)
 * feed the spec-integrity check — hence its own resolution here.
 */
async function runDomainReview(
  args: CliArgs,
): Promise<{ exitCode: number; output: string }> {
  let ctx: AnalysisContext;
  let defsDir: string;
  if (args.project) {
    const mgr = await ProjectManager.load();
    const projectId = mgr.resolveId(args.project);
    ctx = await mgr.getContext(projectId);
    const project = mgr.get(projectId)!;
    defsDir = project.ontologyDir ?? domainsDir(project.rootPath);
  } else {
    ctx = await analyze(args.repoPath);
    defsDir = domainsDir(args.repoPath);
  }
  const domainDefs = await loadEditableDomains(defsDir);
  const report = await buildDomainReview(ctx, { domainDefs });
  if (args.json) return { exitCode: 0, output: JSON.stringify(report, null, 2) };
  return { exitCode: 0, output: formatDomainReview(report) };
}

/**
 * scenes subcommand — derive the scene layer (call-graph reachability from each
 * screen) and merge manually-curated scenes over it. With --project the derived
 * part is served from the fingerprint-keyed artifact cache (the scene cache);
 * manual scenes are merged at read time so editing spec/data/<p>.scenes.json is
 * visible without a re-analysis.
 */
async function runScenes(args: CliArgs): Promise<{ exitCode: number; output: string }> {
  let repoPath: string;
  let projectName: string;
  let derived: DerivedSceneGraph;
  if (args.project) {
    const mgr = await ProjectManager.load();
    const projectId = mgr.resolveId(args.project);
    const project = mgr.get(projectId)!;
    repoPath = project.rootPath;
    projectName = project.name;
    // Fold a custom depth cap into the artifact name so capped and full
    // derivations never cross-serve from the same cache slot.
    const artifactName = args.sceneMaxDepth ? `scenes-derived-d${args.sceneMaxDepth}` : "scenes-derived";
    derived = await mgr.cachedArtifact(projectId, artifactName, async (ctx) =>
      deriveScenes(ctx, await detectScreens(ctx), { maxDepth: args.sceneMaxDepth }),
    );
  } else {
    const ctx = await analyze(args.repoPath);
    repoPath = args.repoPath;
    projectName = basename(args.repoPath);
    derived = await deriveScenes(ctx, await detectScreens(ctx), { maxDepth: args.sceneMaxDepth });
  }
  const manual = await loadScenes(repoPath, projectName);
  const merged = mergeSceneModel(manual, derived.scenes).scenes();
  if (args.json) {
    return { exitCode: 0, output: JSON.stringify({ derived, manual, merged }, null, 2) };
  }
  const lines: string[] = [];
  lines.push(
    `シーン: ${merged.length} scenes (derived ${derived.summary.total}, manual ${manual.length}) — ` +
      `${derived.summary.transitions} transitions, ${derived.summary.domainsCovered} domains covered`,
  );
  for (const scene of derived.scenes) {
    const extras = [
      scene.domains.length ? `domains: ${scene.domains.join(", ")}` : "domains: -",
      scene.transitions.length ? `→ ${scene.transitions.join(", ")}` : "",
      `fns ${scene.entryFunctions}/${scene.reachedFunctions}`,
    ].filter(Boolean);
    lines.push(`  [${scene.kind}] ${scene.id}  ${extras.join("  ")}`);
  }
  return { exitCode: 0, output: lines.join("\n") };
}

/** Human-readable summary of a detected screen composition. */
function formatScreens(graph: ScreenGraph): string {
  const lines: string[] = [];
  const { total, byStack, byKind, edges } = graph.summary;
  lines.push(`画面構成: ${total} screens, ${edges} edges`);
  const fmt = (m: Record<string, number>): string =>
    Object.entries(m)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");
  lines.push(`  stacks: ${fmt(byStack) || "-"}`);
  lines.push(`  kinds:  ${fmt(byKind) || "-"}`);
  lines.push("");
  for (const s of graph.screens) {
    const route = s.route ? ` ${s.route}` : "";
    const loc = s.file ? ` (${s.file}:${s.line})` : "";
    lines.push(`- ${s.name} [${s.stack}/${s.kind}]${route}${loc}`);
    if (s.contains.length) lines.push(`    contains: ${s.contains.join(", ")}`);
    if (s.navigatesTo.length) lines.push(`    → ${s.navigatesTo.join(", ")}`);
    if (s.domains.length) lines.push(`    domains: ${s.domains.join(", ")}`);
  }
  return lines.join("\n");
}

function formatSymbolHits(hits: SymbolHit[]): string {
  if (hits.length === 0) return "(no hits)";
  return hits
    .map((h) => {
      const loc = `${h.filePath}:${h.startLine}`;
      const anchor = h.anchor ? `  ${h.anchor}` : "";
      return `${h.name}  ${loc}  fanIn=${h.fanIn} fanOut=${h.fanOut}${anchor}`;
    })
    .join("\n");
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
      const scope = {
        ...(args.scopePaths ? { paths: args.scopePaths } : {}),
        ...(args.noDomains ? { domains: false as const } : {}),
        ...(args.noSpec ? { spec: false as const } : {}),
      };
      const before = mgr.cache.hits;
      const ctx = await mgr.analyzeProject(targetId, { scope });
      const cacheHit = mgr.cache.hits > before;
      const result = {
        project: targetId,
        files: ctx.files.length,
        functions: ctx.functions.length,
        cacheHit,
        ...(ctx.partial ? { partial: ctx.partial } : {}),
      };
      if (args.json) return { exitCode: 0, output: JSON.stringify(result, null, 2) };
      const partialNote = ctx.partial
        ? ` [partial: ${[
            ...(ctx.partial.paths ? [`paths=${ctx.partial.paths.join(",")}`] : []),
            ...(ctx.partial.domains === false ? ["no-domains"] : []),
            ...(ctx.partial.spec === false ? ["no-spec"] : []),
          ].join(" ")}]`
        : "";
      return {
        exitCode: 0,
        output: `analyzed "${targetId}": ${result.files} files, ${result.functions} functions${cacheHit ? " (cache hit)" : ""}${partialNote}`,
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

  // suggest / draft / reconstruct: analyze -> synthesise. Only draft/reconstruct
  // reconcile and save; suggest is read-only.
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

  if (args.domainsAction === "suggest") {
    if (args.json) {
      return { exitCode: 0, output: JSON.stringify({ drafts }, null, 2) };
    }
    if (!drafts.length) return { exitCode: 0, output: "no domain suggestions" };
    const lines = [`domain suggestions: ${drafts.length}`];
    for (const d of drafts) {
      const paths = d.pathPatterns.length ? ` paths=${d.pathPatterns.join(",")}` : "";
      const specs = d.specRefs.length ? ` specs=${d.specRefs.join(",")}` : "";
      lines.push(`- ${d.name}: ${d.description}${paths}${specs}`);
      if (d.rationale) lines.push(`  ${d.rationale}`);
    }
    return { exitCode: 0, output: lines.join("\n") };
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
// links subcommand — code↔spec link listing + ratification (hardening loop)
// ---------------------------------------------------------------------------

async function runLinks(args: CliArgs): Promise<{ exitCode: number; output: string }> {
  // Resolve repo root + context: --project via the registry, else --repo / cwd.
  let repoRoot = args.repoPath;
  let ctx: AnalysisContext;
  const viaProject = Boolean(args.project);
  if (args.project) {
    const mgr = await ProjectManager.load();
    const projectId = mgr.resolveId(args.project);
    repoRoot = mgr.get(projectId)!.rootPath;
    ctx = await mgr.getContext(projectId);
  } else {
    ctx = await analyze(args.repoPath, { quiet: true });
  }
  const links = ctx.links ?? [];

  if (args.linksAction === "candidates") {
    // The manager path already folded this analysis into the stability state
    // (analyzeWith); the bare-repo path records it here so streaks accrue.
    const state = viaProject
      ? await loadStability(repoRoot)
      : await recordAnalysis(repoRoot, links, await computeFingerprint(repoRoot));
    const candidates = promotionCandidates(state, links);
    if (args.json) {
      return {
        exitCode: 0,
        output: JSON.stringify({ threshold: promoteStreakThreshold(), candidates }, null, 2),
      };
    }
    if (candidates.length === 0) {
      return { exitCode: 0, output: "(no promotion candidates — no non-explicit link has a stable streak yet)" };
    }
    const lines = candidates.map(
      ({ link, streak }) =>
        `${link.from} -> ${link.to}  [${link.evidence} conf=${link.confidence.toFixed(2)} streak=${streak}]`,
    );
    lines.push("", `ratify with: anatomia links ratify <from> <to>${args.project ? ` --project ${args.project}` : ""}`);
    return { exitCode: 0, output: lines.join("\n") };
  }

  if (args.linksAction === "list") {
    if (args.json) return { exitCode: 0, output: JSON.stringify({ links }, null, 2) };
    if (links.length === 0) return { exitCode: 0, output: "(no spec links)" };
    const clauseById = new Map((ctx.specClauses ?? []).map((cl) => [cl.id, cl]));
    const lines = links.map((l) => {
      const heading = clauseById.get(l.to)?.heading ?? "";
      const flags = `${l.evidence} conf=${l.confidence.toFixed(2)}${l.ratified ? " ratified" : ""}`;
      return `${l.from} -> ${l.to}${heading ? ` (${heading})` : ""}  [${flags}]`;
    });
    return { exitCode: 0, output: lines.join("\n") };
  }

  // ratify <from> <to>
  if (!args.linkFrom || !args.linkTo) {
    return {
      exitCode: 1,
      output: "usage: anatomia links ratify <from-anchor> <to-clause-id> [--project <id>]",
    };
  }
  try {
    const result = await ratifyLink({
      repoRoot,
      from: args.linkFrom,
      to: args.linkTo,
      links,
      specClauses: ctx.specClauses ?? [],
    });
    if (args.json) return { exitCode: 0, output: JSON.stringify(result, null, 2) };
    return {
      exitCode: 0,
      output:
        `ratified ${args.linkFrom} -> ${args.linkTo}` +
        `${result.wasProposed ? "" : " (new explicit link — not previously proposed)"}\n` +
        `saved to ${result.path}`,
    };
  } catch (err) {
    if (err instanceof SpecLinkRatifyError) {
      return { exitCode: 1, output: `anatomia links ratify: ${err.message}` };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// trace subcommand — recording path (marker plan + recorded-trace ingest)
// ---------------------------------------------------------------------------

async function runTrace(args: CliArgs): Promise<{ exitCode: number; output: string }> {
  let ctx: AnalysisContext;
  let mgr: ProjectManager | undefined;
  if (args.project) {
    mgr = await ProjectManager.load();
    ctx = await mgr.getContext(args.project);
  } else {
    ctx = await analyze(args.repoPath);
  }
  const domains = (ctx.domains ?? []).filter((d) => d.implementors.length > 0);

  if (args.traceAction === "plan") {
    // Entry points = each domain's implementor functions, resolved to source
    // locations + the AnchorId baked into the generated ANATOMIA_ZONE marker.
    const entryPoints: DomainEntryPoint[] = [];
    for (const d of domains) {
      for (const anchor of d.implementors) {
        const node = await ctx.graph.getNode(anchor as AnchorId);
        if (!node) continue;
        entryPoints.push({
          filePath: node.sourceRange.filePath,
          line: node.sourceRange.start.line,
          anchorId: anchor,
          name: node.name,
        });
      }
    }
    // The recorder is the committed runtime library (runtime/cpp | runtime/csharp);
    // the plan embeds it verbatim plus the project-specific zone patches.
    const lang = args.traceLang ?? "cpp";
    const runtimeName = lang === "csharp" ? "AnatomiaTrace.cs" : "anatomia_zones.h";
    const runtime = lang === "csharp" ? generateCSharpStub(true) : generateCppHeader(true);
    const patches = lang === "csharp" ? generateCSharpPatches(entryPoints) : generateCppPatches(entryPoints);
    if (args.traceOut) {
      await mkdir(args.traceOut, { recursive: true });
      await writeFile(join(args.traceOut, runtimeName), runtime, "utf8");
      await writeFile(join(args.traceOut, "anatomia_zones.patches.json"), JSON.stringify(patches, null, 2), "utf8");
    }
    if (args.json) {
      return { exitCode: 0, output: JSON.stringify({ lang, entryPoints: entryPoints.length, patches, out: args.traceOut ?? null }, null, 2) };
    }
    const buildHint = lang === "csharp"
      ? "  define ANATOMIA_MEASUREMENT_BUILD (Unity: Scripting Define Symbols) and set ANATOMIA_TRACE_FILE to record\n" +
        "  (call Anatomia.Trace.FrameBegin/FrameEnd around the main-loop frame)."
      : "  build the game with -DANATOMIA_MEASUREMENT_BUILD and set ANATOMIA_TRACE_FILE to record\n" +
        "  (add ANATOMIA_FRAME_BEGIN/END around the main-loop frame).";
    return {
      exitCode: 0,
      output:
        `trace plan (${lang}) — ${domains.length} domains, ${entryPoints.length} zone markers\n` +
        (args.traceOut
          ? `  wrote ${join(args.traceOut, runtimeName)} + patches.json\n`
          : "  (pass --out <dir> to write the runtime + patch list)\n") +
        buildHint,
    };
  }

  // ingest: recorded JSONL → scenes (+ optional integral run with those scenes).
  if (!args.traceFile) {
    return { exitCode: 1, output: "usage: anatomia trace ingest --file <trace.jsonl> [--project <id>] [--entry <ref> --scope ...]" };
  }
  const jsonl = await readFile(args.traceFile, "utf8");
  const scenes = sceneModelFromTraceFile(jsonl, domains);
  const sceneList = scenes.scenes();

  if (args.entry) {
    const { evaluation } = await evaluateModulesFromGraph(ctx.graph, ctx.functions);
    const query: IntegralQuery = { entry: { ref: args.entry, scope: args.scope ?? "function" }, range: { climb: "scene-adjacent" } };
    const report = await runIntegral(ctx, query, { scenes, moduleEval: evaluation });
    if (args.json) return { exitCode: 0, output: JSON.stringify({ scenes: sceneList, report }, null, 2) };
    return {
      exitCode: 0,
      output:
        `trace ingest — ${sceneList.length} scenes from ${args.traceFile}\n` +
        formatIntegral(report),
    };
  }

  if (args.json) return { exitCode: 0, output: JSON.stringify({ scenes: sceneList }, null, 2) };
  const lines = [`trace ingest — ${sceneList.length} scenes from ${args.traceFile}`];
  for (const s of sceneList.slice(0, 20)) {
    lines.push(`  - ${s.id.slice(0, 8)}… ${s.label ? `(${s.label}) ` : ""}domains=[${s.domains.join(", ")}]`);
  }
  return { exitCode: 0, output: lines.join("\n") };
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
    initVestigium();
    installCrashLogging();
    vgWrite("info", "anatomia cli web start", { port: args.port ?? 4200, home_dir: args.homeDir ?? null });
    try {
      const mgr = await ProjectManager.load({ homeDir: args.homeDir });
      await startServer({ ctx: mgr, port: args.port ?? 4200 });
    } catch (err) {
      vgCrash("cli.web", err);
      await vgShutdown();
      throw err;
    }
    // startServer starts the Hono listener; the event loop keeps the process alive.
    return;
  }

  initVestigium({ captureConsole: false });
  installCrashLogging();
  const obsCtx = cliObsContext(args);
  vgWrite("info", "anatomia cli start", obsCtx);
  let result: { exitCode: number; output: string };
  try {
    result = await withVgSpan(`cli.${args.subcommand}`, obsCtx, () => runCli(args));
  } catch (err) {
    await vgShutdown();
    throw err;
  }
  const { exitCode, output } = result;
  vgWrite(exitCode === 0 ? "info" : "warn", "anatomia cli exit", { ...obsCtx, exit_code: exitCode });
  await vgShutdown();
  await writeThenExit(process.stdout, output + "\n", exitCode);
}

function cliObsContext(args: CliArgs): Record<string, unknown> {
  return {
    subcommand: args.subcommand,
    project: args.project ?? null,
    project_action: args.projectAction ?? null,
    repo: args.repoPath,
  };
}
