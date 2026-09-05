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
 *   pr-review     -- ephemeral branch-diff domain/quality report; exit 0
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
  buildDomainReviewByLayer,
  formatDomainReview,
  formatDomainReviewByLayer,
  buildPrDiffReview,
} from "../review/index.js";
import { loadProgramDomainConfig } from "../domains/program/index.js";
import { hasKnowledgeLog, resolveUxCriticalDomainNames } from "../supply/plan/index.js";
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
import { detectEntryPoints } from "../entrypoints/index.js";
import type { ScreenGraph } from "../screens/index.js";
import { deriveScenes, type DerivedSceneGraph } from "../scenes/derive.js";
import { loadScenes, mergeSceneModel } from "../scenes/store.js";
import { sceneModelFromInspection } from "../scenes/canonical.js";
import { KnowledgeApplicationService, knowledgePortFromManager } from "../knowledge/application/index.js";
import { ProjectManager } from "../project/manager.js";
import { exportGraphHtml } from "./web/export.js";
import { runEntryPoints } from "./entrypoints-cli.js";
import { runPlan } from "./plan-cli.js";
import { PLAN_DIR_REL, latestPlanFile, loadPlan } from "../supply/plan/index.js";
import type { Plan } from "../supply/plan/index.js";
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
  synthesizeDomainDrafts,
  seedDraftsFromStructure,
  type DomainDraft,
} from "../domains/authoring/index.js";
import { diagnoseProgramDomains, type ProgramDomainDiagnosis } from "../domains/program/index.js";
import { resolveCommittedOntologyDir } from "../domains/ontology.js";
import { effectiveOntologyDir } from "../project/config-paths.js";
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

export type ProjectAction = "add" | "list" | "remove" | "analyze" | "spec";
export type DomainsAction = "draft" | "list" | "reconstruct" | "suggest" | "program";
export type TraceAction = "plan" | "ingest";
export type LinksAction = "list" | "ratify" | "candidates";
export type KnowledgeAction = "status" | "migration-plan";

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
    | "pr-review"
    | "project"
    | "export-graph"
    | "web"
    | "cache-stats"
    | "integral"
    | "domains"
    | "trace"
    | "screens"
    | "scenes"
    | "entrypoints"
    | "knowledge"
    | "links"
    | "plan";
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
  /** For knowledge: shared service status or read-only legacy migration plan. */
  knowledgeAction?: KnowledgeAction;
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
  /** For domains: explicit domains dir (default <repoRoot>/spec/domains). */
  dir?: string;
  /** For domains program: list only the unclassified modules. */
  unclassifiedOnly?: boolean;
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
  /** For pr-review: explicit branch/base ref (default resolution is origin/main, main, ...). */
  base?: string;
  /** For pr-review: make the migration's dual-layer gate affect the exit code. */
  enforceDualLayerDomainGate?: boolean;
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
  /** For entrypoints: show one entry's reach tree (anchor or symbol name). */
  entryRef?: string;
  /** For entrypoints: list the symbols no entry reaches. */
  unrooted?: boolean;
  /** For entrypoints: list the call sites static resolution dropped. */
  frontier?: boolean;
  /** For export-graph: which forest to render. Default: the whole call graph. */
  exportMode?: "graph" | "entrypoints";
  /** For project spec: dirs to set as the spec source (repeatable --set). */
  specSetDirs?: string[];
  /** For project spec: clear the config (back to auto-detect default). */
  specClear?: boolean;
  /** For plan: every `--project` given, in order (a plan may span repos). */
  projects?: string[];
  /** For domain-review: also aggregate coverage / violations / cohesion per layer. */
  byLayer?: boolean;
  /** For plan: output shape. "okf" renders the delegation-ready OKF document. */
  planFormat?: "markdown" | "okf";
  /**
   * For verify: the plan JSON to check the diff against. An empty string means
   * `--plan` was passed with no path — use the repo's most recent plan.
   */
  planPath?: string;
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
    subcommand !== "pr-review" &&
    subcommand !== "project" &&
    subcommand !== "export-graph" &&
    subcommand !== "web" &&
    subcommand !== "cache-stats" &&
    subcommand !== "integral" &&
    subcommand !== "domains" &&
    subcommand !== "trace" &&
    subcommand !== "screens" &&
    subcommand !== "scenes" &&
    subcommand !== "entrypoints" &&
    subcommand !== "knowledge" &&
    subcommand !== "links" &&
    subcommand !== "plan"
  ) {
    throw new Error(
      `Unknown subcommand "${subcommand ?? ""}". Expected: verify | context | where | find | callers | callees | review | spec-review | domain-review | pr-review | project | export-graph | web | cache-stats | integral | domains | trace | screens | scenes | entrypoints | knowledge | links | plan`,
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

  if (subcommand === "knowledge") {
    return parseKnowledgeArgs(args);
  }

  if (subcommand === "plan") {
    return parsePlanArgs(args);
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
  let base: string | undefined;
  let enforceDualLayerDomainGate = false;
  let sceneMaxDepth: number | undefined;
  let entryRef: string | undefined;
  let unrooted = false;
  let byLayer = false;
  let frontier = false;
  let exportMode: "graph" | "entrypoints" | undefined;
  let planPath: string | undefined;

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
    } else if (flag === "--mode" && subcommand === "export-graph") {
      const value = args[++i];
      if (value !== "graph" && value !== "entrypoints") {
        throw new Error(`Invalid --mode "${value ?? ""}". Expected: graph | entrypoints`);
      }
      exportMode = value;
    } else if (flag === "--entry" && subcommand === "entrypoints") {
      entryRef = args[++i];
    } else if (flag === "--by-layer") {
      byLayer = true;
    } else if (flag === "--unrooted") {
      unrooted = true;
    } else if (flag === "--frontier") {
      frontier = true;
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
    } else if (flag === "--plan") {
      // Optional value: `--plan` alone means "the repo's most recent plan".
      const next = args[i + 1];
      planPath = next !== undefined && !next.startsWith("-") ? args[++i] : "";
    } else if (flag === "--base") {
      base = args[++i];
    } else if (flag === "--enforce-dual-layer-domain-gate") {
      enforceDualLayerDomainGate = true;
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

  return { subcommand, repoPath, diff, file, task, symbol, mode, limit, json, project, output, baselinePath, writeBaseline, base, enforceDualLayerDomainGate, sceneMaxDepth, entryRef, unrooted, frontier, byLayer, exportMode, planPath };
}

/**
 * `plan --task "<日本語可>" [--project <id> ...] [--repo <path>] [--json]
 *  [--no-llm] [--format okf]`
 *
 * `--project` is REPEATABLE: a task like "切り絵のデモを実装する" spans Pictor
 * (demo/shader/Visus) and Figmentum (image transform), and planning them
 * separately would lose exactly the cross-repo split the plan exists to show.
 */
function parsePlanArgs(args: string[]): CliArgs {
  let repoPath = process.cwd();
  let task: string | undefined;
  let json = false;
  let noLlm = false;
  let planFormat: "markdown" | "okf" = "markdown";
  const projects: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--task" || flag === "-t") {
      task = args[++i];
    } else if (flag === "--project" || flag === "-p") {
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("plan --project requires an id");
      projects.push(value);
    } else if (flag === "--repo" || flag === "-r") {
      repoPath = args[++i] ?? repoPath;
    } else if (flag === "--json" || flag === "-j") {
      json = true;
    } else if (flag === "--no-llm") {
      noLlm = true;
    } else if (flag === "--format") {
      const value = args[++i];
      if (value !== "markdown" && value !== "okf") {
        throw new Error(`Invalid --format "${value ?? ""}". Expected: markdown | okf`);
      }
      planFormat = value;
    } else {
      throw new Error(`Unknown plan option "${flag}"`);
    }
  }
  if (!task || task.trim() === "") throw new Error("plan requires --task \"<task>\"");
  return {
    subcommand: "plan",
    repoPath,
    task,
    json,
    noLlm,
    planFormat,
    ...(projects.length > 0 ? { projects, project: projects[0] } : {}),
  };
}

/**
 * Pull changed paths from unified-diff header pairs. The post-image path wins;
 * deletions use the pre-image path. Returns a de-duplicated list in order.
 */
export function diffTargetPaths(diff: string): string[] {
  const out: string[] = [];
  let oldPath: string | null = null;
  let awaitingNewPath = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("--- ")) {
      oldPath = normalizeDiffHeaderPath(line.slice(4));
      awaitingNewPath = true;
      continue;
    }
    if (!awaitingNewPath || !line.startsWith("+++ ")) continue;
    const path = normalizeDiffHeaderPath(line.slice(4)) ?? oldPath;
    if (path && !out.includes(path)) out.push(path);
    awaitingNewPath = false;
    oldPath = null;
  }
  return out;
}

function normalizeDiffHeaderPath(raw: string): string | null {
  const path = raw.trim().replace(/\t.*$/, "");
  if (path === "/dev/null" || path === "") return null;
  return path.replace(/^[ab]\//, "");
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
  if (
    action !== "add" && action !== "list" && action !== "remove" &&
    action !== "analyze" && action !== "spec"
  ) {
    throw new Error(
      `Unknown project action "${action ?? ""}". Expected: add | list | remove | analyze | spec`,
    );
  }

  let json = false;
  let noDomains = false;
  let noSpec = false;
  let specClear = false;
  const scopePaths: string[] = [];
  const specSetDirs: string[] = [];
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
    else if (a === "--set") {
      const d = args[++i];
      if (!d) throw new Error("--set expects a spec dir path");
      specSetDirs.push(d);
    } else if (a === "--clear") specClear = true;
    else positionals.push(a);
  }
  if ((scopePaths.length > 0 || noDomains || noSpec) && action !== "analyze") {
    throw new Error("--path / --no-domains / --no-spec only apply to `project analyze`");
  }
  if ((specSetDirs.length > 0 || specClear) && action !== "spec") {
    throw new Error("--set / --clear only apply to `project spec`");
  }
  if (specSetDirs.length > 0 && specClear) {
    throw new Error("--set and --clear are mutually exclusive");
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
    ...(specSetDirs.length > 0 ? { specSetDirs } : {}),
    ...(specClear ? { specClear } : {}),
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
  if (action !== "draft" && action !== "list" && action !== "reconstruct" && action !== "suggest" && action !== "program") {
    throw new Error(`Unknown domains action "${action ?? ""}". Expected: draft | list | reconstruct | suggest | program`);
  }
  let repoPath = process.cwd();
  let project: string | undefined;
  let dir: string | undefined;
  let only: string[] | undefined;
  let force = false;
  let noLlm = false;
  let json = false;
  let unclassifiedOnly = false;
  let repoSpecified = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--repo" || a === "-r") {
      repoPath = args[++i] ?? repoPath;
      repoSpecified = true;
    }
    else if (a === "--project" || a === "-p") project = args[++i];
    else if (a === "--dir") dir = args[++i];
    else if (a === "--only") only = (args[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--force") force = true;
    else if (a === "--no-llm") noLlm = true;
    else if (a === "--unclassified") unclassifiedOnly = true;
    else if (a === "--json" || a === "-j") json = true;
  }
  if (action === "program" && project && repoSpecified) {
    throw new Error("domains program accepts either --project <id> or --repo <path>, not both");
  }
  return { subcommand: "domains", repoPath, project, domainsAction: action, dir, only, force, noLlm, json, unclassifiedOnly };
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

function parseKnowledgeArgs(args: string[]): CliArgs {
  const action = args.shift();
  if (action !== "status" && action !== "migration-plan") {
    throw new Error(`Unknown knowledge action "${action ?? ""}". Expected: status | migration-plan`);
  }
  let project: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" || args[i] === "-p") {
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("knowledge --project requires an id");
      project = value;
    }
    else if (args[i] === "--json" || args[i] === "-j") json = true;
    else throw new Error(`Unknown knowledge option "${args[i]}"`);
  }
  return { subcommand: "knowledge", repoPath: process.cwd(), project, json, knowledgeAction: action };
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

  if (args.subcommand === "knowledge") {
    return runKnowledge(args);
  }

  if (args.subcommand === "plan") {
    return runPlan(args);
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

  if (args.subcommand === "entrypoints") {
    return runEntryPoints(args);
  }

  const ctx = await resolveContext(args);

  if (args.subcommand === "pr-review") {
    const report = await buildPrDiffReview(ctx, {
      base: args.base,
      dualLayerMode: args.enforceDualLayerDomainGate ? "enforced" : "advisory",
    });
    return {
      exitCode: report.domain.dualLayer.blocking || report.spec.dualLayer.blocking ? 1 : 0,
      output: JSON.stringify(report, null, 2),
    };
  }

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

    const plan = await resolveVerifyPlan(args, ctx.repoPath);
    const verdict = await buildVerdict(ctx, diffSource, args.file, {
      ...(plan ? { plan } : {}),
      ...(plan ? { planRepo: resolveVerifyPlanRepo(args, plan) } : {}),
    });
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
    const html = await exportGraphHtml(ctx, {
      title: undefined,
      ...(args.exportMode ? { mode: args.exportMode } : {}),
    });
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
 * The plan `verify --plan` checks the diff against.
 *
 * `--plan <path>` reads that file; a bare `--plan` takes the repo's most recent
 * plan, which is what a PR opened right after `anatomia plan` wants. A missing
 * or unreadable file THROWS rather than quietly verifying without the gate the
 * user explicitly asked for (RULE_CODE §7).
 */
async function resolveVerifyPlan(args: CliArgs, repoPath: string): Promise<Plan | undefined> {
  if (args.planPath === undefined) return undefined;
  let file: string | null = args.planPath;
  if (file === "") {
    file = await latestPlanFile(repoPath);
    if (file === null) {
      throw new Error(
        `--plan was given but ${repoPath} has no plan under ${PLAN_DIR_REL}; run \`anatomia plan --task ...\` first.`,
      );
    }
  }
  return loadPlan(file);
}

/** Resolve which slice of a cross-repo plan applies to this checkout. */
function resolveVerifyPlanRepo(args: CliArgs, plan: Plan): string {
  if (plan.storedForRepo) return plan.storedForRepo;
  if (args.project && plan.repos.includes(args.project)) return args.project;
  if (plan.repos.length === 1) return plan.repos[0]!;
  throw new Error(
    "cross-repo plan has no repository identity; use the copy saved in the target repo or pass --project",
  );
}

/**
 * Resolve the AnalysisContext for verify/context/where. With --project, analyze
 * the registered project (cache-aware) via the persisted ProjectManager;
 * otherwise analyze the --repo / cwd path directly (legacy behaviour).
 */
async function resolveContext(args: CliArgs): Promise<AnalysisContext> {
  // pr-review is ephemeral by contract (feature/pr-diff-review.md): it must never
  // route through ProjectManager's persistent cache, so --project is rejected
  // rather than silently downgraded to an unrelated cwd analysis.
  if (args.subcommand === "pr-review") {
    if (args.project) {
      throw new Error(
        "pr-review is ephemeral and cannot use --project; pass --repo <worktree> instead.",
      );
    }
    // No pluginDir override: analyze() resolves the repo's committed domain
    // dir itself (`spec/domains`, then the legacy locations). Passing a dir
    // here is what used to make the PR gate read a DIFFERENT ontology than
    // everyday analysis in repos that carried both, so the adapter no longer
    // picks one.
    return analyze(args.repoPath, {});
  }
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
  let knowledgeWriteRoot: string | undefined;
  let knowledgeProjectId = basename(args.repoPath);
  let autoDiscovered = false;
  if (args.project) {
    const mgr = await ProjectManager.load();
    const projectId = mgr.resolveId(args.project);
    knowledgeProjectId = projectId;
    ctx = await mgr.getContext(projectId);
    const project = mgr.get(projectId)!;
    knowledgeWriteRoot = project.knowledgeWriteRoot;
    const operatorDomainsDir = effectiveOntologyDir(project) ?? process.env["ANATOMIA_PLUGIN_DIR"];
    defsDir = operatorDomainsDir
      ?? resolveCommittedOntologyDir(project.rootPath)
      ?? domainsDir(project.rootPath);
    autoDiscovered = operatorDomainsDir === undefined;
  } else {
    ctx = await analyze(args.repoPath);
    const operatorDomainsDir = process.env["ANATOMIA_PLUGIN_DIR"];
    defsDir = operatorDomainsDir
      ?? resolveCommittedOntologyDir(args.repoPath)
      ?? domainsDir(args.repoPath);
    autoDiscovered = operatorDomainsDir === undefined;
  }
  const domainDefs = await loadEditableDomains(defsDir, { skipInvalid: autoDiscovered });
  let uxCriticalDomains: string[] = [];
  // A-10: the UX-critical mark comes from approved `domain-owns-code`, resolved
  // outside the (pure) review builder.
  if (await hasKnowledgeLog(ctx.repoPath, knowledgeProjectId, knowledgeWriteRoot)) {
    const screens = await detectScreens(ctx);
    const entries = await detectEntryPoints(ctx, { screens });
    uxCriticalDomains = await resolveUxCriticalDomainNames({
      repoPath: ctx.repoPath,
      projectId: knowledgeProjectId,
      knowledgeWriteRoot,
      detections: (ctx.domains ?? []).map((detection) => ({
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
  const report = await buildDomainReview(ctx, { domainDefs, uxCriticalDomains });
  if (!args.byLayer) {
    if (args.json) return { exitCode: 0, output: JSON.stringify(report, null, 2) };
    return { exitCode: 0, output: formatDomainReview(report) };
  }
  // A lens, not a gate: the by-layer aggregation never changes the exit code.
  const config = await loadProgramDomainConfig(ctx.repoPath);
  const byLayer = await buildDomainReviewByLayer(ctx, report, config);
  if (args.json) return { exitCode: 0, output: JSON.stringify({ ...report, byLayer }, null, 2) };
  return { exitCode: 0, output: [formatDomainReview(report), formatDomainReviewByLayer(byLayer)].join("\n") };
}

/**
 * scenes subcommand — registered projects read the revision-validated canonical
 * scene manifest. The unregistered one-off path retains the legacy in-memory
 * derivation until project migration assigns a knowledgeWriteRoot.
 */
async function runScenes(args: CliArgs): Promise<{ exitCode: number; output: string }> {
  if (args.project) {
    const mgr = await ProjectManager.load();
    const projectId = mgr.resolveId(args.project);
    let inspection;
    try { inspection = await new KnowledgeApplicationService(knowledgePortFromManager(mgr, projectId)).scenes.query(); }
    catch (error) {
      return { exitCode: 1, output: `scene manifest unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (args.json) return { exitCode: inspection.stale ? 1 : 0, output: JSON.stringify(inspection, null, 2) };
    const lines = [
      `シーン: ${inspection.scenes.length} canonical scenes — head ${inspection.manifest.knowledgeHead}`,
      `source ${inspection.manifest.sourceRevision} / schema ${inspection.manifest.projectionSchema}${inspection.stale ? ` / STALE: ${inspection.staleReasons.join(", ")}` : ""}`,
    ];
    for (const scene of inspection.scenes) {
      lines.push(
        `  [${scene.kind}] ${scene.id}  direct ${scene.entryCodeSymbolIds.length}`
        + ` / reached ${scene.reachedCodeSymbolIds.length}`
        + `  domains: ${scene.activeDomainIds.join(", ") || "-"}`
        + `  source: ${scene.sourceAnchor.path}:${scene.sourceAnchor.startLine}`,
      );
    }
    return { exitCode: inspection.stale ? 1 : 0, output: lines.join("\n") };
  }
  const ctx = await analyze(args.repoPath);
  const repoPath = args.repoPath;
  const projectName = basename(args.repoPath);
  const derived: DerivedSceneGraph = await deriveScenes(ctx, await detectScreens(ctx), { maxDepth: args.sceneMaxDepth });
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

/**
 * Derive + commit the entry-point graph for a freshly analyzed project. Reported
 * rather than thrown: a project whose knowledge root is not writable still gets
 * its analysis, it just does not get an entry graph.
 */
async function syncEntryPointGraph(
  manager: ProjectManager,
  projectId: string,
): Promise<{ status: "synced"; entries: number } | { status: "skipped"; reason: string }> {
  try {
    const result = await new KnowledgeApplicationService(
      knowledgePortFromManager(manager, projectId),
    ).entrypoints.sync();
    return { status: "synced", entries: result.manifest.entries.length };
  } catch (error) {
    return { status: "skipped", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function runKnowledge(args: CliArgs): Promise<{ exitCode: number; output: string }> {
  const manager = await ProjectManager.load();
  const application = new KnowledgeApplicationService(knowledgePortFromManager(manager, args.project));
  if (args.knowledgeAction === "migration-plan") {
    const plan = await application.planLegacyMigration();
    return { exitCode: plan.canApply ? 0 : 1, output: JSON.stringify(plan, null, 2) };
  }
  const status = await application.status();
  if (args.json) return { exitCode: status.rebuildRequired ? 1 : 0, output: JSON.stringify(status, null, 2) };
  return {
    exitCode: status.rebuildRequired ? 1 : 0,
    output: `knowledge ${status.projectId}: head ${status.knowledgeHead ?? "<empty>"} / scene ${status.sceneProjection}`
      + (status.staleReasons.length > 0 ? ` / ${status.staleReasons.join(", ")}` : ""),
  };
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
      const specConfig = await mgr.ensureSpecConfig(targetId);
      // The entry graph is derived as part of analyze so every later reader
      // (panel, CLI, harness) gets it from cache without re-analysing. A scoped
      // run is non-canonical, so it is skipped; a sync failure must not fail the
      // analysis it rides on.
      const entrypoints = ctx.partial
        ? { status: "skipped" as const, reason: "partial analysis" }
        : await syncEntryPointGraph(mgr, targetId);
      const result = {
        project: targetId,
        files: ctx.files.length,
        functions: ctx.functions.length,
        cacheHit,
        specConfig,
        entrypoints,
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
      const specNote = formatSpecConfigNote(specConfig);
      const entryNote = entrypoints.status === "synced"
        ? `入口: ${entrypoints.entries} entries`
        : `入口: ${entrypoints.status} (${entrypoints.reason})`;
      return {
        exitCode: 0,
        output:
          `analyzed "${targetId}": ${result.files} files, ${result.functions} functions${cacheHit ? " (cache hit)" : ""}${partialNote}` +
          `\n${entryNote}` +
          (specNote ? `\n${specNote}` : ""),
      };
    }

    case "spec": {
      const [id] = pos;
      let targetId: string;
      try {
        targetId = mgr.resolveId(id);
      } catch (err) {
        return { exitCode: 1, output: err instanceof Error ? err.message : String(err) };
      }
      if (args.specSetDirs || args.specClear) {
        // Relative --set paths resolve against the project root (the natural
        // frame for "spec is at ../spec" / "docs/spec").
        const root = mgr.get(targetId)!.rootPath;
        const dirs = args.specSetDirs?.map((d) => resolvePath(root, d)) ?? null;
        try {
          await mgr.updateSpecDirs(targetId, dirs);
        } catch (err) {
          return { exitCode: 1, output: err instanceof Error ? err.message : String(err) };
        }
      }
      const status = await mgr.ensureSpecConfig(targetId);
      if (args.json) {
        return { exitCode: 0, output: JSON.stringify({ project: targetId, ...status }, null, 2) };
      }
      const lines = [`spec source for "${targetId}": ${status.source}`];
      for (const d of status.dirs ?? []) lines.push(`  ${d}`);
      const note = formatSpecConfigNote(status);
      if (note) lines.push(note);
      lines.push(
        "  (set: anatomia project spec <id> --set <dir> [--set <dir>...] / clear: --clear)",
      );
      return { exitCode: 0, output: lines.join("\n") };
    }

    default:
      return { exitCode: 1, output: "Unknown project action" };
  }
}

/** Human-readable one-liner for a non-default spec-source resolution. */
function formatSpecConfigNote(status: { source: string; dirs?: string[] }): string {
  if (status.source === "auto") {
    return `  spec: auto-detected -> ${(status.dirs ?? []).join(", ")}`;
  }
  if (status.source === "missing") {
    return (
      "  spec: NOT FOUND — no markdown under the project root and no spec/docs candidate nearby.\n" +
      "        Point Anatomia at the spec tree: anatomia project spec <id> --set <dir>"
    );
  }
  return "";
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
  let scenes = emptySceneModel();
  if (args.project) {
    const mgr = await ProjectManager.load();
    const projectId = mgr.resolveId(args.project);
    ctx = await mgr.getContext(projectId);
    fingerprint = await mgr.fingerprint(projectId);
    try {
      const inspection = await new KnowledgeApplicationService(knowledgePortFromManager(mgr, projectId)).scenes.query();
      if (inspection.stale) {
        return { exitCode: 1, output: `scene manifest is stale: ${inspection.staleReasons.join(", ")}` };
      }
      scenes = sceneModelFromInspection(inspection);
    } catch (error) {
      return { exitCode: 1, output: `scene manifest unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
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
    scenes,
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
  let projectOntologyDir: string | undefined;
  if (args.project) {
    mgr = await ProjectManager.load();
    projectId = mgr.resolveId(args.project);
    const project = mgr.get(projectId)!;
    repoRoot = project.rootPath;
    projectOntologyDir = effectiveOntologyDir(project);
  }
  const operatorDomainsDir = projectOntologyDir ?? process.env["ANATOMIA_PLUGIN_DIR"];
  const autoDiscovered = args.dir === undefined && operatorDomainsDir === undefined;
  const dir = args.dir
    ?? operatorDomainsDir
    ?? resolveCommittedOntologyDir(repoRoot)
    ?? domainsDir(repoRoot);

  if (args.domainsAction === "list") {
    const defs = await loadEditableDomains(dir, { skipInvalid: autoDiscovered });
    if (args.json) return { exitCode: 0, output: JSON.stringify({ dir, domains: defs }, null, 2) };
    if (!defs.length) return { exitCode: 0, output: `(no editable domains in ${dir})` };
    const lines = defs.map(
      (d) => `${d.name}\t[${d.source}]\t${d.presetRules.length} rules${d.mechanics?.length ? `\tmech: ${d.mechanics.join(",")}` : ""}`,
    );
    return { exitCode: 0, output: lines.join("\n") };
  }

  if (args.domainsAction === "program") {
    // Program-domain (two-layer) diagnosis: the operator's check that
    // `.anatomia/layers.json` covers every module before the Revisor gate is
    // switched to enforced. A lens, not a gate: exit 0 regardless of count.
    const ctx = args.project ? await mgr!.getContext(projectId) : await analyze(repoRoot, { quiet: true });
    const diagnosis = await diagnoseProgramDomains({ repoPath: repoRoot, functions: ctx.functions });
    return { exitCode: 0, output: formatProgramDiagnosis(diagnosis, { json: args.json === true, unclassifiedOnly: args.unclassifiedOnly === true }) };
  }

  if (args.domainsAction !== "suggest") {
    return {
      exitCode: 1,
      output: "direct DomainDef write was removed; use the domain-organization Gate A/B/C workflow. Existing files remain migration inputs.",
    };
  }

  // suggest is the only remaining synthesis path and is read-only.
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

  throw new Error("unreachable domains action");
}

/** Render `domains program` output (JSON or a layer → unclassified summary). */
function formatProgramDiagnosis(
  diagnosis: ProgramDomainDiagnosis,
  options: { json: boolean; unclassifiedOnly: boolean },
): string {
  if (options.json) {
    const { graph: _graph, ...rest } = diagnosis;
    const payload = options.unclassifiedOnly
      ? { repoPath: rest.repoPath, configPresent: rest.configPresent, totals: rest.totals, unclassified: rest.unclassified }
      : rest;
    return JSON.stringify(payload, null, 2);
  }
  const lines: string[] = [];
  if (!options.unclassifiedOnly) {
    lines.push(
      `program domains: ${diagnosis.totals.domains} (modules ${diagnosis.totals.modules}, symbols ${diagnosis.totals.symbols})`,
      `layers.json: ${diagnosis.configPresent ? `${diagnosis.config.layers.length} rule(s)` : "absent (builtin + framework + heuristic only)"}`,
    );
    if (diagnosis.layers.length) {
      lines.push("layers:");
      for (const layer of diagnosis.layers) {
        lines.push(`  ${layer.layer}\t${layer.domainCount} domain(s)\t${layer.moduleCount} module(s)\t${layer.symbolCount} symbol(s)`);
      }
    }
  }
  lines.push(`unclassified: ${diagnosis.totals.unclassifiedModules} module(s), ${diagnosis.totals.unclassifiedSymbols} symbol(s)`);
  for (const item of diagnosis.unclassified) {
    lines.push(`  - ${item.moduleId}\t${item.symbolCount} symbol(s)\t${item.reason}`);
    for (const file of item.files) lines.push(`      ${file}`);
  }
  if (diagnosis.unclassified.length === 0) {
    lines.push("  (every module has a layer — the two-layer program gate would pass)");
  } else {
    lines.push("hint: add { \"glob\": \"<path glob>\", \"layer\": \"<layer>\" } entries to .anatomia/layers.json for the files above.");
  }
  return lines.join("\n");
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
 * Write `text` to a stdio stream, wait for it to flush, then let the process
 * exit with `code` **by draining the event loop**, not by `process.exit()`.
 *
 * On Windows, stdout/stderr backed by a pipe (a hook redirect, a backfill loop
 * capturing output) are *asynchronous*: write() hands the data to libuv and
 * returns before the OS pipe has drained. Waiting for the write callback closes
 * that race and guarantees the output is never truncated.
 *
 * A direct `process.exit()` immediately after the flush can still race with
 * Windows libuv shutdown work. Setting `process.exitCode` instead lets that
 * work drain naturally. A detached fallback timer hard-exits if a stray handle
 * keeps the loop alive; because it is `unref`'d, the timer itself cannot delay
 * normal shutdown.
 */
const EXIT_DRAIN_FALLBACK_MS = 5_000;

async function writeThenExit(
  stream: NodeJS.WriteStream,
  text: string,
  code: number,
): Promise<void> {
  await new Promise<void>((resolve) => stream.write(text, () => resolve()));
  process.exitCode = code;
  const fallback = setTimeout(() => process.exit(code), EXIT_DRAIN_FALLBACK_MS);
  fallback.unref?.();
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
