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
import { loadOntology } from "./domains/ontology.js";
import { detectDomains } from "./domains/detect.js";
import { parseSpecFiles } from "./spec/parse.js";
import { findExplicitLinks } from "./spec/explicit.js";
import { findStructuralLinks } from "./spec/structural.js";
import type { AnchorId, ContextBundle, FileNode, FunctionNode, Link, SpecClause, Verdict } from "./types.js";
import type { Landing, LandingTask, DomainDetector, LayerRules, SiblingLookup } from "./supply/landing.js";
import type { DetectionResult } from "./domains/detect.js";
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
  /** Domain-detection results from the builtin ontology + plugins (G3). */
  domains?: DetectionResult[];
  /** Files that could not be read or parsed (skipped, with reason). */
  skipped?: { filePath: string; reason: string }[];
}

export interface BundleRequest {
  task: string;
  domainHints?: string[];
}

/** Options for analyze(). */
export interface AnalyzeOptions {
  /** Suppress per-file skip warnings (default: warn to console). */
  quiet?: boolean;
  /** Explicit domain-ontology plugin dir (else ANATOMIA_PLUGIN_DIR). */
  pluginDir?: string;
}

// ---------------------------------------------------------------------------
// Source file discovery
// ---------------------------------------------------------------------------

const SOURCE_EXTS = new Set([".cpp", ".h", ".cs", ".ts", ".tsx"]);
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
  if (ext === ".tsx") return "tsx";
  if (ext === ".ts") return "typescript";
  return "cpp";
}

/**
 * Detect the language of a diff for the verify path.
 *
 * Priority: explicit `targetPath` → the unified-diff `+++ b/<path>` header →
 * default C++ (so raw, path-less snippets behave as before). Reuses `langFor`
 * (the same extension→Lang map `analyze()` uses) so the verify path and the
 * analysis path agree on grammar selection.
 */
function langForDiff(diff: string, targetPath?: string): Lang {
  if (targetPath) return langFor(targetPath);
  const headerPath = diffTargetPath(diff);
  if (headerPath) return langFor(headerPath);
  return "cpp";
}

/**
 * Extract the post-image file path from a unified diff's `+++ b/<path>` header.
 * Returns null when the input is not a unified diff or has no `+++` line.
 */
function diffTargetPath(diff: string): string | null {
  for (const line of diff.split(/\r?\n/)) {
    if (!line.startsWith("+++ ")) continue;
    let p = line.slice(4).trim();
    // Strip a trailing tab-separated timestamp some diff tools append.
    const tab = p.indexOf("\t");
    if (tab >= 0) p = p.slice(0, tab);
    if (p === "/dev/null") return null;
    // Drop the conventional `b/` (or `a/`) prefix.
    p = p.replace(/^[ab]\//, "");
    if (p.length > 0) return p;
  }
  return null;
}

/** Path segments that should be excluded from TypeScript source collection. */
const TS_EXCLUDE_SEGMENTS = new Set(["node_modules", "dist", ".git"]);

/**
 * Return true if the path should be skipped for TS/TSX:
 *   - declaration files (*.d.ts)
 *   - files under node_modules / dist / .git
 */
function shouldSkipTsPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.endsWith(".d.ts")) return true;
  const segments = normalized.split("/");
  return segments.some((s) => TS_EXCLUDE_SEGMENTS.has(s));
}

// ---------------------------------------------------------------------------
// analyze — main entry point
// ---------------------------------------------------------------------------

/**
 * Run the whole G1→G5 chain on a real repo:
 *   discover .cpp/.h/.cs → parse → extract → normalize → hash → Merkle DAG →
 *   code graph → domain detection → spec linking → (supply/verify ready).
 *
 * Un-parseable / unreadable files are skipped with a warning (the analysis does
 * not crash); they are recorded in `skipped`. The parser WASM is cached globally.
 */
export async function analyze(
  repoPath: string,
  options: AnalyzeOptions = {},
): Promise<AnalysisContext> {
  const rawFilePaths = await collectSourceFiles(repoPath);
  // For TypeScript files, skip *.d.ts and files under node_modules/dist.
  const filePaths = rawFilePaths.filter((fp) => {
    const ext = extname(fp).toLowerCase();
    if (ext === ".ts" || ext === ".tsx") return !shouldSkipTsPath(fp);
    return true;
  });

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

  // Phase 4 — domain detection (G3). Builtin ontology + optional plugins.
  let domains: DetectionResult[] = [];
  try {
    const ontology = await loadOntology(options.pluginDir);
    domains = await detectDomains(ontology, graph, allFunctions);
  } catch (err) {
    if (!options.quiet) {
      console.warn(`[anatomia/analyze] domain detection failed: ${String(err)}`);
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
    domains,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// buildContextBundle
// ---------------------------------------------------------------------------

/**
 * Assemble a minimal but real-shaped ContextBundle for the given task.
 * Full G3-G5 domain resolution is not wired here; adapters use what is
 * available in the AnalysisContext.
 */
export async function buildContextBundle(
  ctx: AnalysisContext,
  req: BundleRequest,
): Promise<ContextBundle> {
  // Up to 5 hashed exemplars from the context (source-order first).
  const exemplars = ctx.functions.filter((f) => f.id !== null).slice(0, 5);

  // Stub injections for landing resolution (no real domain db in adapters).
  const stubDetector: DomainDetector = async (task: LandingTask) =>
    task.domainHints ?? ["general"];
  const stubLayerRules: LayerRules = { layerFor: () => null };
  const stubSiblings: SiblingLookup = async () => [];

  const landings = await resolveLanding(
    { description: req.task, domainHints: req.domainHints },
    stubDetector,
    stubLayerRules,
    stubSiblings,
  );

  const landingAnchors = landings
    .map((l) => l.anchor)
    .filter((a): a is AnchorId => a !== null);

  // Existing domains that actually have implementors in this repo feed the
  // duplication-avoidance segment of the bundle (DESIGN §9.1 ①).
  const existingDomains = (ctx.domains ?? [])
    .filter((m) => m.implementors.length > 0)
    .map((m) => m.domain);

  const { bundle } = assembleBundle({
    landingAnchors,
    rules: [],
    specClauses: ctx.specClauses ?? [],
    exemplars,
    impactRadius: [],
    existingDomains,
  });

  return bundle;
}

// ---------------------------------------------------------------------------
// buildVerdict
// ---------------------------------------------------------------------------

/**
 * Parse `diff` with the correct grammar for its language, then run the 5-gate
 * verify pipeline. Uses a zero-vector mock embed client (no real LLM calls).
 *
 * Language is detected (in priority order):
 *   1. an explicit `targetPath` (the file the diff applies to), via `langFor`;
 *   2. the unified-diff `+++ b/<path>.<ext>` header, via `langFor`;
 *   3. defaulting to C++ (preserves prior behaviour for raw, path-less snippets).
 *
 * This makes the verify path language-aware: a TypeScript diff is parsed with
 * the TS grammar (so TS-only syntax is handled, not mis-parsed as C++), a C++
 * diff with the cpp grammar, and a C# diff with the c_sharp grammar.
 */
export async function buildVerdict(
  ctx: AnalysisContext,
  diff: string,
  targetPath?: string,
): Promise<Verdict> {
  const source = sourceFromDiffInput(diff);
  const lang = langForDiff(diff, targetPath);
  const tree = await parse(source, lang);
  const fns = extractFunctions(tree, source, targetPath ?? "<diff>");
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
