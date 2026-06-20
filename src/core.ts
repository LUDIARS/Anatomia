/**
 * core.ts — Wiring module for G6 adapters.
 *
 * Exposes `analyze(repoPath)` which runs the full G1-G5 pipeline and returns
 * an AnalysisContext. Also exposes convenience helpers that adapters call
 * without duplicating pipeline logic.
 *
 * SRP: wiring only. No new analysis logic lives here.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { collectFilesByExt } from "./fs/walk.js";
import { parse } from "./dag/parser.js";
import { extractFunctions, extractTypeDecls } from "./dag/extract.js";
import { normalize } from "./dag/normalize.js";
import { assignAnchorId } from "./dag/hash.js";
import { buildFileNode } from "./dag/merkle.js";
import { buildGraph, extractEdgeInfo, augmentGraph } from "./graph/build.js";
import { InMemoryCodeGraph } from "./graph/in-memory.js";
import { assembleBundle } from "./supply/bundle.js";
import { verify, buildDefaultGates } from "./supply/verify.js";
import { resolveLanding } from "./supply/landing.js";
import { loadOntology } from "./domains/ontology.js";
import { detectDomains } from "./domains/detect.js";
import { compileDomainRules } from "./domains/compile.js";
import { generateCard, createCardCache } from "./domains/card.js";
import type { CardCache, LLMClient } from "./domains/card.js";
import type { Providers } from "./providers/index.js";
import { parseSpecFiles } from "./spec/parse.js";
import { findExplicitLinks } from "./spec/explicit.js";
import { findStructuralLinks } from "./spec/structural.js";
import type { AnchorId, ContextBundle, FileNode, FunctionNode, Link, Rule, SpecClause, TypeDecl, Verdict } from "./types.js";
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
  /**
   * Preset rules compiled from the active ontology (builtin + plugins). These
   * are the rules the supply bundle lists and the verify pipeline evaluates.
   */
  rules?: Rule[];
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
  /**
   * Extra directories to scan for `spec/*.md` clauses, in addition to repoPath.
   * Needed when a project's code root is a subdirectory (e.g. `<repo>/src`) but
   * its spec lives at a sibling (`<repo>/spec`): register the code root for a
   * clean graph, point specDirs at the spec tree for linkage.
   */
  specDirs?: string[];
}

// ---------------------------------------------------------------------------
// Source file discovery
// ---------------------------------------------------------------------------

const SOURCE_EXTS = new Set([".cpp", ".h", ".cs", ".ts", ".tsx"]);
const SPEC_EXTS = new Set([".md"]);

// Source-file discovery uses the directory-pruning walk in fs/walk.ts so huge
// node_modules/dist trees are never enumerated (see that file for the why).

function collectSourceFiles(dir: string): Promise<string[]> {
  return collectFilesByExt(dir, SOURCE_EXTS);
}

function collectSpecFiles(dir: string): Promise<string[]> {
  return collectFilesByExt(dir, SPEC_EXTS);
}

/** Detect language from file extension. Defaults to "cpp" for .h and .cpp. */
export function langFor(filePath: string): Lang {
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
    let typeDecls: TypeDecl[] = [];
    try {
      const tree = await parse(src, lang);
      fns = extractFunctions(tree, src, filePath);
      typeDecls = extractTypeDecls(tree, filePath);
      for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst));
    } catch (err) {
      // Parse / extract / normalize failure on one file must not abort the run.
      warn(filePath, `parse/extract failed (${String(err)})`);
      continue;
    }
    files.push(buildFileNode(filePath, fns, typeDecls));
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
  let rules: Rule[] = [];
  try {
    const ontology = await loadOntology(options.pluginDir);
    domains = await detectDomains(ontology, graph, allFunctions);
    // Surface the ontology's preset rules so supply can list them and verify
    // can evaluate them (detection only reports violations on existing code).
    rules = compileDomainRules(ontology);
  } catch (err) {
    if (!options.quiet) {
      console.warn(`[anatomia/analyze] domain detection failed: ${String(err)}`);
    }
  }

  // Phase 5 — spec linking (G4). Parse markdown, then explicit + structural links.
  let specClauses: SpecClause[] = [];
  let links: Link[] = [];
  try {
    // Scan the code root plus any extra spec dirs (e.g. a sibling spec/ when the
    // code root is <repo>/src). De-dupe so an overlapping dir is not parsed twice.
    const specRoots = [repoPath, ...(options.specDirs ?? [])];
    const collected = await Promise.all(specRoots.map((d) => collectSpecFiles(d)));
    const specPaths = [...new Set(collected.flat())];
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
    rules,
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
  const activeDomains = (ctx.domains ?? []).filter((m) => m.implementors.length > 0);
  const existingDomains = activeDomains.map((m) => m.domain);

  // Applicable rules = the preset rules of domains that are actually present in
  // this repo (rule id is `${domain}/preset#i`), so the bundle advises the agent
  // with the conventions that apply here rather than every catalogued rule.
  const activeNames = new Set(existingDomains);
  const applicable = (ctx.rules ?? []).filter((r) => activeNames.has(r.id.split("/")[0]!));

  const { bundle } = assembleBundle({
    landingAnchors,
    rules: applicable,
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
export interface VerifyOptions {
  /**
   * Production providers (real embedder + LLM). When present, the duplication
   * gate runs against the real embedder and the existing domains are distilled
   * into cards (via providers.llm) to compare against — so duplication is a
   * meaningful flag rather than a always-pass mock.
   */
  providers?: Providers;
  /** Reused card cache (content-keyed) so repeated verify calls skip the LLM. */
  cardCache?: CardCache;
}

export async function buildVerdict(
  ctx: AnalysisContext,
  diff: string,
  targetPath?: string,
  opts?: VerifyOptions,
): Promise<Verdict> {
  const source = sourceFromDiffInput(diff);
  const lang = langForDiff(diff, targetPath);
  const tree = await parse(source, lang);
  // tree-sitter Tree は WASM メモリを所有する。diff の fns/bodyAst は buildVerdict 内で
  // しか使われない (verdict は anchor 文字列のみ保持) ので、verify 完了後に必ず解放する。
  // これをしないと warm サーバの per-verify で Tree がリークし WASM 枯渇 (Aborted) する。
  try {
  const fns = extractFunctions(tree, source, targetPath ?? "<diff>");
  const diffTypes = extractTypeDecls(tree, targetPath ?? "<diff>");
  for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst));

  // Diff-augmented graph: overlay the new functions + their outgoing edges onto
  // the analyzed graph so rule_conformance sees brand-new violating calls (a
  // call into a forbidden layer is invisible against the unmodified graph). Must
  // run while the tree is alive (extractEdgeInfo walks bodyAst), before delete().
  const diffFile = buildFileNode(targetPath ?? "<diff>", fns, diffTypes);
  const diffEdgeInfo = extractEdgeInfo([diffFile]);
  const verifyGraph = new InMemoryCodeGraph(
    augmentGraph(ctx.graph.raw, [diffFile], diffEdgeInfo),
  );

  // Embedder + domain cards.
  //   With providers: real embedder + LLM-distilled domain-card texts, so the
  //     duplication gate actually flags reinvented domains (DESIGN §9.1 ③).
  //   Without: zero-vector mock embed + no cards → duplication gate passes
  //     (preserves the hermetic, API-free default used by tests/adapters).
  let embed = opts?.providers?.embed;
  let domainCards: { domain: string; text: string }[] | undefined;
  if (opts?.providers) {
    domainCards = await buildDomainCardTexts(
      ctx,
      opts.providers.llm,
      opts.cardCache,
      opts.providers.llmModelId,
    );
  } else {
    embed = async (texts: string[]): Promise<number[][]> => texts.map(() => [0]);
  }

  const diffInput: DiffInput = {
    changed: fns,
    graph: verifyGraph,
    // Pre-change graph for delta gates (coupling_delta compares against this).
    baseGraph: ctx.graph,
    domainCards,
    // Domain + global rules so the rule_conformance gate can evaluate them.
    rules: ctx.rules ?? [],
    // Real spec clauses + links so the spec_linkage gate has context to judge
    // whether the changed functions tie into any spec clause (orphan warning).
    specClauses: ctx.specClauses ?? [],
    links: ctx.links ?? [],
  };

  const gates = buildDefaultGates({ embed: embed! });
    return await verify(diffInput, gates);
  } finally {
    tree.delete();
  }
}

/**
 * Distil each non-empty detected domain into a card and return its compare
 * text (summary + rules) for the duplication gate. Content-keyed via the
 * card cache, so unchanged domains do not re-invoke the LLM.
 */
async function buildDomainCardTexts(
  ctx: AnalysisContext,
  llm: LLMClient,
  cache: CardCache = createCardCache(),
  modelId?: string,
): Promise<{ domain: string; text: string }[]> {
  const out: { domain: string; text: string }[] = [];
  for (const d of ctx.domains ?? []) {
    if (d.implementors.length === 0) continue;
    const card = await generateCard(d.domain, d, ctx.graph, llm, cache, { modelId });
    out.push({ domain: card.domain, text: [card.summary, ...card.rules].join("\n") });
  }
  return out;
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
