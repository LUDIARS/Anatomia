/**
 * core.ts — Wiring module for G6 adapters.
 *
 * Exposes `analyze(repoPath)` which runs the full G1-G5 pipeline and returns
 * an AnalysisContext. Also exposes convenience helpers that adapters call
 * without duplicating pipeline logic.
 *
 * SRP: wiring only. No new analysis logic lives here.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { parse } from "./dag/parser.js";
import { extractFunctions } from "./dag/extract.js";
import { normalize } from "./dag/normalize.js";
import { assignAnchorId } from "./dag/hash.js";
import { buildFileNode } from "./dag/merkle.js";
import { buildGraph, extractEdgeInfo } from "./graph/build.js";
import { InMemoryCodeGraph } from "./graph/in-memory.js";
import { assembleBundle } from "./supply/bundle.js";
import { verify, buildDefaultGates } from "./supply/verify.js";
import { resolveLanding } from "./supply/landing.js";
import { loadOntology } from "./mechanics/ontology.js";
import { detectMechanics } from "./mechanics/detect.js";
import { parseSpecFiles } from "./spec/parse.js";
import { findExplicitLinks } from "./spec/explicit.js";
import { findStructuralLinks } from "./spec/structural.js";
import type { AnchorId, ContextBundle, FileNode, FunctionNode, Link, SpecClause, Verdict } from "./types.js";
import type { Landing, LandingTask, MechanicDetector, LayerRules, SiblingLookup } from "./supply/landing.js";
import type { DetectionResult } from "./mechanics/detect.js";
import type { DiffInput } from "./supply/gates/types.js";
import type { Lang } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnalysisContext {
  repoPath: string;
  /** Implements CodeGraphQuery over the built graph. */
  graph: InMemoryCodeGraph;
  files: FileNode[];
  functions: FunctionNode[];
  /**
   * The following are always populated by `analyze()`. They are optional in the
   * type so adapter tests / external callers can build a minimal context (just
   * graph + files + functions) without the G3/G4 layers.
   */
  /** Spec clauses parsed from spec/*.md + DESIGN.md under repoPath (G4). */
  specClauses?: SpecClause[];
  /** Explicit + structural code↔spec links (G4). */
  links?: Link[];
  /** Mechanic-detection results from the builtin ontology + plugins (G3). */
  mechanics?: DetectionResult[];
  /** Files that could not be read or parsed (skipped, with reason). */
  skipped?: { filePath: string; reason: string }[];
}

export interface BundleRequest {
  task: string;
  mechanicHints?: string[];
}

/** Options for analyze(). */
export interface AnalyzeOptions {
  /** Suppress per-file skip warnings (default: warn to console). */
  quiet?: boolean;
  /** Explicit mechanic-ontology plugin dir (else ANATOMIA_PLUGIN_DIR). */
  pluginDir?: string;
}

// ---------------------------------------------------------------------------
// Source file discovery
// ---------------------------------------------------------------------------

const SOURCE_EXTS = new Set([".cpp", ".h", ".cs"]);
const SPEC_EXTS = new Set([".md"]);

/** Collect files under `dir` (recursive) whose extension is in `exts`. */
async function collectFilesByExt(dir: string, exts: Set<string>): Promise<string[]> {
  const result: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true }) as import("node:fs").Dirent[];
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!exts.has(ext)) continue;
    const parentPath: string =
      (entry as unknown as { parentPath?: string }).parentPath ??
      (entry as unknown as { path?: string }).path ??
      dir;
    result.push(join(parentPath, entry.name));
  }
  return result;
}

function collectSourceFiles(dir: string): Promise<string[]> {
  return collectFilesByExt(dir, SOURCE_EXTS);
}

function collectSpecFiles(dir: string): Promise<string[]> {
  return collectFilesByExt(dir, SPEC_EXTS);
}

/** Detect language from file extension. Defaults to "cpp" for .h and .cpp. */
function langFor(filePath: string): Lang {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".cs") return "c_sharp";
  return "cpp";
}

// ---------------------------------------------------------------------------
// analyze — main entry point
// ---------------------------------------------------------------------------

/**
 * Run the whole G1→G5 chain on a real repo:
 *   discover .cpp/.h/.cs → parse → extract → normalize → hash → Merkle DAG →
 *   code graph → mechanic detection → spec linking → (supply/verify ready).
 *
 * Un-parseable / unreadable files are skipped with a warning (the analysis does
 * not crash); they are recorded in `skipped`. The parser WASM is cached globally.
 */
export async function analyze(
  repoPath: string,
  options: AnalyzeOptions = {},
): Promise<AnalysisContext> {
  const filePaths = await collectSourceFiles(repoPath);

  const files: FileNode[] = [];
  const allFunctions: FunctionNode[] = [];
  const skipped: { filePath: string; reason: string }[] = [];

  const warn = (filePath: string, reason: string): void => {
    skipped.push({ filePath, reason });
    if (!options.quiet) {
      console.warn(`[anatomia/analyze] skipping ${filePath}: ${reason}`);
    }
  };

  // Phase 1 — parse + extract + hash (trees must remain alive for edge extraction).
  for (const filePath of filePaths) {
    let src: string;
    try {
      src = await readFile(filePath, "utf8");
    } catch (err) {
      warn(filePath, `read failed (${String(err)})`);
      continue;
    }
    const lang = langFor(filePath);
    let fns: FunctionNode[];
    try {
      const tree = await parse(src, lang);
      fns = extractFunctions(tree, src, filePath);
      for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst));
    } catch (err) {
      // Parse / extract / normalize failure on one file must not abort the run.
      warn(filePath, `parse/extract failed (${String(err)})`);
      continue;
    }
    files.push(buildFileNode(filePath, fns));
    allFunctions.push(...fns);
    // NOTE: trees are NOT deleted here so that extractEdgeInfo can walk the AST.
  }

  // Phase 2 — extract edge info while trees are still alive.
  const edgeInfo = extractEdgeInfo(files);

  // Phase 3 — build graph (safe after edge extraction).
  const codeGraph = buildGraph(files, edgeInfo);
  const graph = new InMemoryCodeGraph(codeGraph);

  // Phase 4 — mechanic detection (G3). Builtin ontology + optional plugins.
  let mechanics: DetectionResult[] = [];
  try {
    const ontology = await loadOntology(options.pluginDir);
    mechanics = await detectMechanics(ontology, graph, allFunctions);
  } catch (err) {
    if (!options.quiet) {
      console.warn(`[anatomia/analyze] mechanic detection failed: ${String(err)}`);
    }
  }

  // Phase 5 — spec linking (G4). Parse markdown, then explicit + structural links.
  let specClauses: SpecClause[] = [];
  let links: Link[] = [];
  try {
    const specPaths = await collectSpecFiles(repoPath);
    if (specPaths.length > 0) {
      specClauses = await parseSpecFiles(specPaths);
      const sourcePaths = files.map((f) => f.path);
      const [explicit, structural] = await Promise.all([
        findExplicitLinks(specClauses, sourcePaths),
        findStructuralLinks(specClauses, sourcePaths),
      ]);
      links = [...explicit, ...structural];
    }
  } catch (err) {
    if (!options.quiet) {
      console.warn(`[anatomia/analyze] spec linking failed: ${String(err)}`);
    }
  }

  return {
    repoPath,
    graph,
    files,
    functions: allFunctions,
    specClauses,
    links,
    mechanics,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// buildContextBundle
// ---------------------------------------------------------------------------

/**
 * Assemble a minimal but real-shaped ContextBundle for the given task.
 * Full G3-G5 mechanic resolution is not wired here; adapters use what is
 * available in the AnalysisContext.
 */
export async function buildContextBundle(
  ctx: AnalysisContext,
  req: BundleRequest,
): Promise<ContextBundle> {
  // Up to 5 hashed exemplars from the context (source-order first).
  const exemplars = ctx.functions.filter((f) => f.id !== null).slice(0, 5);

  // Stub injections for landing resolution (no real mechanic db in adapters).
  const stubDetector: MechanicDetector = async (task: LandingTask) =>
    task.mechanicHints ?? ["general"];
  const stubLayerRules: LayerRules = { layerFor: () => null };
  const stubSiblings: SiblingLookup = async () => [];

  const landings = await resolveLanding(
    { description: req.task, mechanicHints: req.mechanicHints },
    stubDetector,
    stubLayerRules,
    stubSiblings,
  );

  const landingAnchors = landings
    .map((l) => l.anchor)
    .filter((a): a is AnchorId => a !== null);

  // Existing mechanics that actually have implementors in this repo feed the
  // duplication-avoidance segment of the bundle (DESIGN §9.1 ①).
  const existingMechanics = (ctx.mechanics ?? [])
    .filter((m) => m.implementors.length > 0)
    .map((m) => m.mechanic);

  const { bundle } = assembleBundle({
    landingAnchors,
    rules: [],
    specClauses: ctx.specClauses ?? [],
    exemplars,
    impactRadius: [],
    existingMechanics,
  });

  return bundle;
}

// ---------------------------------------------------------------------------
// buildVerdict
// ---------------------------------------------------------------------------

/**
 * Parse `diff` as C++ source, then run the 5-gate verify pipeline.
 * Uses a zero-vector mock embed client (no real LLM calls from adapters).
 */
export async function buildVerdict(ctx: AnalysisContext, diff: string): Promise<Verdict> {
  const source = sourceFromDiffInput(diff);
  const tree = await parse(source, "cpp");
  const fns = extractFunctions(tree, source, "<diff>");
  for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst));

  // Mock embed: zero vectors → duplication gate always passes (no similarity).
  const mockEmbed = async (texts: string[]): Promise<number[][]> =>
    texts.map(() => [0]);

  const diffInput: DiffInput = {
    changed: fns,
    graph: ctx.graph,
    // Real spec clauses + links so the spec_linkage gate has context to judge
    // whether the changed functions tie into any spec clause (orphan warning).
    specClauses: ctx.specClauses ?? [],
    links: ctx.links ?? [],
  };

  const gates = buildDefaultGates({ embed: mockEmbed });
  return verify(diffInput, gates);
}

function sourceFromDiffInput(input: string): string {
  if (!looksLikeUnifiedDiff(input)) return input;

  const postImageLines: string[] = [];
  let inHunk = false;

  for (const line of input.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("diff --git ") || line.startsWith("index ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("\\ No newline")) continue;

    if (line.startsWith("+") || line.startsWith(" ")) {
      postImageLines.push(line.slice(1));
    }
  }

  return postImageLines.length > 0 ? postImageLines.join("\n") : input;
}

function looksLikeUnifiedDiff(input: string): boolean {
  return /^diff --git /m.test(input) || /^@@ .* @@/m.test(input);
}

// ---------------------------------------------------------------------------
// getImpactRadius
// ---------------------------------------------------------------------------

/**
 * BFS-reachable set from the given anchor (outgoing edges).
 */
export async function getImpactRadius(
  ctx: AnalysisContext,
  anchor: AnchorId,
): Promise<AnchorId[]> {
  const nodes = await ctx.graph.reachable(anchor);
  return nodes.map((n) => n.id);
}

// ---------------------------------------------------------------------------
// Re-export types adapters need
// ---------------------------------------------------------------------------

export type { Landing, LandingTask };
