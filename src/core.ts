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
import type { AnchorId, ContextBundle, FileNode, FunctionNode, Verdict } from "./types.js";
import type { Landing, LandingTask, MechanicDetector, LayerRules, SiblingLookup } from "./supply/landing.js";
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
}

export interface BundleRequest {
  task: string;
  mechanicHints?: string[];
}

// ---------------------------------------------------------------------------
// Source file discovery
// ---------------------------------------------------------------------------

const SOURCE_EXTS = new Set([".cpp", ".h", ".cs"]);

async function collectSourceFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true }) as import("node:fs").Dirent[];
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name);
    if (!SOURCE_EXTS.has(ext)) continue;
    const parentPath: string =
      (entry as unknown as { parentPath?: string }).parentPath ??
      (entry as unknown as { path?: string }).path ??
      dir;
    result.push(join(parentPath, entry.name));
  }
  return result;
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
 * Scan all .cpp/.h/.cs files under repoPath, build the full G1-G2 graph, and
 * return an AnalysisContext. The parser WASM is cached globally across calls.
 */
export async function analyze(repoPath: string): Promise<AnalysisContext> {
  const filePaths = await collectSourceFiles(repoPath);

  const files: FileNode[] = [];
  const allFunctions: FunctionNode[] = [];

  // Phase 1 — parse + extract + hash (trees must remain alive for edge extraction).
  for (const filePath of filePaths) {
    let src: string;
    try {
      src = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const lang = langFor(filePath);
    const tree = await parse(src, lang);
    const fns = extractFunctions(tree, src, filePath);
    for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst));
    const fileNode = buildFileNode(filePath, fns);
    files.push(fileNode);
    allFunctions.push(...fns);
    // NOTE: trees are NOT deleted here so that extractEdgeInfo can walk the AST.
  }

  // Phase 2 — extract edge info while trees are still alive.
  const edgeInfo = extractEdgeInfo(files);

  // Phase 3 — build graph (safe after edge extraction).
  const codeGraph = buildGraph(files, edgeInfo);
  const graph = new InMemoryCodeGraph(codeGraph);

  return { repoPath, graph, files, functions: allFunctions };
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

  const { bundle } = assembleBundle({
    landingAnchors,
    rules: [],
    specClauses: [],
    exemplars,
    impactRadius: [],
    existingMechanics: [],
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
  const tree = await parse(diff, "cpp");
  const fns = extractFunctions(tree, diff, "<diff>");
  for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst));

  // Mock embed: zero vectors → duplication gate always passes (no similarity).
  const mockEmbed = async (texts: string[]): Promise<number[][]> =>
    texts.map(() => [0]);

  const diffInput: DiffInput = {
    changed: fns,
    graph: ctx.graph,
  };

  const gates = buildDefaultGates({ embed: mockEmbed });
  return verify(diffInput, gates);
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
