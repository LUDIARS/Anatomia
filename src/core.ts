/**
 * core.ts — Wiring module for G6 adapters.
 *
 * Exposes `analyze(repoPath)` which runs the full G1-G5 pipeline and returns
 * an AnalysisContext. Also exposes convenience helpers that adapters call
 * without duplicating pipeline logic.
 *
 * SRP: wiring only. No new analysis logic lives here.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Tree } from "web-tree-sitter";
import { collectFilesByExt, readGitignoreDirs, EXCLUDE_DIRS } from "./fs/walk.js";
import { parse } from "./dag/parser.js";
import { extractFunctions, extractTypeDecls } from "./dag/extract.js";
import { normalize } from "./dag/normalize.js";
import { assignAnchorId } from "./dag/hash.js";
import { buildFileNode } from "./dag/merkle.js";
import { buildGraph, extractEdgeInfo, augmentGraph } from "./graph/build.js";
import type { CodeGraph } from "./graph/build.js";
import { graphCacheKey, filesContentKey } from "./graph/cache.js";
import { InMemoryCodeGraph } from "./graph/in-memory.js";
import { assembleBundle } from "./supply/bundle.js";
import { sharedBundleCache, BUNDLE_CACHE_VERSION } from "./supply/cache.js";
import { verify, buildDefaultGates } from "./supply/verify.js";
import { resolveLanding } from "./supply/landing.js";
import { loadOntology } from "./domains/ontology.js";
import { detectDomains } from "./domains/detect.js";
import { detectionCacheKey } from "./domains/cache.js";
import { compileDomainRules } from "./domains/compile.js";
import { generateCard, createCardCache } from "./domains/card.js";
import type { CardCache, LLMClient } from "./domains/card.js";
import { createCachedEmbedder, sharedEmbeddingCache } from "./cache/embedding.js";
import type { CachedVector } from "./cache/embedding.js";
import { versionedKey } from "./cache/store.js";
import type { CacheStore } from "./cache/store.js";
import type { CacheTranscript } from "./cache/transcript.js";
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
  /**
   * Per-file analysis reuse: prior FileNodes keyed by absolute path. When a
   * file's current source SHA-256 equals the prior FileNode's `contentHash`, the
   * whole FileNode (with its already-detached bodyAst mirrors) is reused as-is
   * and parse/extract/normalize is skipped for that file. Only the project's
   * changed files are re-parsed — the rest come straight from this map. The
   * project's fingerprint already short-circuits the all-unchanged case
   * (project/cache.ts); this is the partial-change fast path. In-process only
   * (bodyAst mirrors are not serialisable), so prior FileNodes must come from a
   * live earlier analyze() of the same project.
   */
  priorFiles?: Map<string, FileNode>;
  /**
   * Content-keyed cache for the Phase-4 domain-detection result. Keyed by file
   * paths + structural hashes + ontology (domains/cache.ts), so a fingerprint
   * miss that left the code identical (spec/config edit) reuses detection instead
   * of re-running O(domains × functions). Omit → always recompute.
   */
  detectionCache?: CacheStore<DetectionResult[]>;
  /**
   * Content-keyed cache for the Phase 2/3 built code graph. Keyed by file paths +
   * structural hashes (graph/cache.ts), so a fingerprint miss that left the code
   * identical (spec/config edit) reuses the graph instead of re-extracting edges
   * and rebuilding. Omit → always rebuild.
   */
  graphCache?: CacheStore<CodeGraph>;
  /**
   * Cache transcript + session for observability. When present, the per-file
   * reuse loop records one `get` event (ns "perfile", hit = reused) per file, so
   * cache-stats reports the per-file hit-rate alongside the other caches. The
   * graph/detection caches passed above are expected to be instrumentStore-wrapped
   * by the caller, so they record themselves. Omit → no measurement.
   */
  transcript?: CacheTranscript;
  session?: string;
}

// ---------------------------------------------------------------------------
// Source file discovery
// ---------------------------------------------------------------------------

const SOURCE_EXTS = new Set([".cpp", ".h", ".cs", ".ts", ".tsx"]);
const SPEC_EXTS = new Set([".md"]);

// Source-file discovery uses the directory-pruning walk in fs/walk.ts so huge
// node_modules/dist trees are never enumerated (see that file for the why).

async function collectSourceFiles(dir: string): Promise<string[]> {
  const gitDirs = await readGitignoreDirs(dir);
  return collectFilesByExt(dir, SOURCE_EXTS, new Set([...EXCLUDE_DIRS, ...gitDirs]));
}

async function collectSpecFiles(dir: string): Promise<string[]> {
  const gitDirs = await readGitignoreDirs(dir);
  return collectFilesByExt(dir, SPEC_EXTS, new Set([...EXCLUDE_DIRS, ...gitDirs]));
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

/**
 * Detect a tree-sitter WASM `Abort`. Once emscripten aborts the shared module
 * (typically heap exhaustion at the 2GB ceiling), it stays dead for the life of
 * the process, so this signals "stop parsing — only a restart recovers".
 */
function isWasmAbort(err: unknown): boolean {
  return /Aborted\(\)/.test(String(err));
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
  // web-tree-sitter trees own emscripten heap that GC does NOT reclaim; the heap
  // is capped at 2GB (`maximum: 32768` 64KB pages). extractFunctions detaches
  // each body into a plain-JS AstNode mirror (dag/freeze.ts), so a file's Tree
  // can be delete()d the instant its functions/types are extracted — bounding
  // the live native heap to ONE file at a time rather than the whole repo (which
  // exhausted the heap on large repos and poisoned the shared WASM module with a
  // cascading `Aborted()` flood — task #335). Every consumer past phase 1
  // (edge extraction, template matching) reads the detached mirror, not the tree.

  const warn = (filePath: string, reason: string): void => {
    skipped.push({ filePath, reason });
    if (!options.quiet) {
      console.warn(`[anatomia/analyze] skipping ${filePath}: ${reason}`);
    }
  };

  // Phase 1 — parse + extract + hash. Each file's tree is freed as soon as its
  // functions (with detached bodyAst) and type decls are extracted.
  for (const filePath of filePaths) {
    let src: string;
    try {
      src = await readFile(filePath, "utf8");
    } catch (err) {
      warn(filePath, `read failed (${String(err)})`);
      continue;
    }
    const contentHash = createHash("sha256").update(src, "utf8").digest("hex");
    // Per-file reuse: an unchanged file's prior FileNode (with its detached
    // bodyAst mirrors) is reused verbatim, skipping parse/extract entirely — so
    // a partial edit only re-parses the files that actually changed. This also
    // shrinks the live WASM heap pressure that the per-file tree.delete() guards
    // against, since reused files never touch the parser at all.
    const prior = options.priorFiles?.get(filePath);
    const reused = prior != null && prior.contentHash === contentHash;
    options.transcript?.record({
      kind: "get", ts: Date.now(), session: options.session ?? "",
      ns: "perfile", hit: reused, key: contentHash,
    });
    if (reused) {
      files.push(prior);
      allFunctions.push(...prior.functions);
      continue;
    }
    const lang = langFor(filePath);
    let fns: FunctionNode[];
    let typeDecls: TypeDecl[] = [];
    let tree: Tree | null = null;
    try {
      tree = await parse(src, lang);
      // extractFunctions detaches each body (freezeBody) → the tree is no longer
      // needed once extraction + anchor hashing (both read the detached mirror)
      // complete.
      fns = extractFunctions(tree, src, filePath);
      typeDecls = extractTypeDecls(tree, filePath);
      for (const fn of fns) assignAnchorId(fn, normalize(fn.bodyAst));
    } catch (err) {
      // Parse / extract / normalize failure on one file must not abort the run.
      warn(filePath, `parse/extract failed (${String(err)})`);
      // A tree-sitter WASM `Abort` is unrecoverable: emscripten marks the shared
      // module instance dead, so EVERY subsequent parse in this process aborts
      // too. Continuing would flood the log with tens of thousands of identical
      // `Aborted()` lines and stall for minutes before returning a near-empty
      // result. Stop the scan now; the warm server's next restart gets a fresh
      // module. (Per-file freeing above is what keeps us from reaching this.)
      if (isWasmAbort(err)) {
        if (!options.quiet) {
          console.warn(
            "[anatomia/analyze] tree-sitter WASM aborted (heap exhausted); " +
              "stopping scan — restart clears the poisoned module",
          );
        }
        break;
      }
      continue;
    } finally {
      // Bodies are detached; release this file's native memory now.
      if (tree) {
        try {
          tree.delete();
        } catch {
          // A tree from an aborted parse may already be unusable; ignore.
        }
      }
    }
    const fileNode = buildFileNode(filePath, fns, typeDecls);
    fileNode.contentHash = contentHash;
    files.push(fileNode);
    allFunctions.push(...fns);
  }

  // Phase 2/3 — edge extraction + graph build. Reused when the code identity is
  // unchanged (e.g. a spec/config-only edit that busts the fingerprint but not
  // the code): the largest uncached slice of a re-analysis. No cache → build.
  let codeGraph: CodeGraph;
  const graphCache = options.graphCache;
  if (graphCache) {
    const key = graphCacheKey(files);
    const hit = await graphCache.get(key);
    if (hit) {
      codeGraph = hit;
    } else {
      codeGraph = buildGraph(files, extractEdgeInfo(files));
      await graphCache.set(key, codeGraph);
    }
  } else {
    codeGraph = buildGraph(files, extractEdgeInfo(files));
  }
  const graph = new InMemoryCodeGraph(codeGraph);

  // Phase 4 — domain detection (G3). Builtin ontology + optional plugins.
  let domains: DetectionResult[] = [];
  let rules: Rule[] = [];
  try {
    const ontology = await loadOntology(options.pluginDir);
    // Detection is O(domains × functions). Reuse the prior result when the code
    // identity (file paths + structural hashes) and ontology are unchanged — the
    // spec/config-only-edit case, where the fingerprint busts but the DAG does
    // not. No cache configured → always recompute (the hermetic default).
    const detectionCache = options.detectionCache;
    if (detectionCache) {
      const key = detectionCacheKey(files, ontology);
      const hit = await detectionCache.get(key);
      if (hit) {
        domains = hit;
      } else {
        domains = await detectDomains(ontology, graph, allFunctions);
        await detectionCache.set(key, domains);
      }
    } else {
      domains = await detectDomains(ontology, graph, allFunctions);
    }
    // Surface the ontology's preset rules so supply can list them and verify
    // can evaluate them (detection only reports violations on existing code).
    rules = compileDomainRules(ontology);
  } catch (err) {
    if (!options.quiet) {
      console.warn(`[anatomia/analyze] domain detection failed: ${String(err)}`);
    }
  }

  // (Trees were freed per-file in phase 1; the detached bodyAst mirrors retained
  // on the returned context are plain JS and pin no native memory.)

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
  bundleCache: CacheStore<ContextBundle> = sharedBundleCache(),
): Promise<ContextBundle> {
  const key = bundleCacheKey(ctx, req);
  const cached = await bundleCache.get(key);
  if (cached) return cached;

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

  await bundleCache.set(key, bundle);
  return bundle;
}

/**
 * Cache key for a context bundle. Folds the request (task + domain hints) with a
 * digest of EVERY ctx field the bundle reads — files (path + structural hash),
 * spec clauses (which can live outside ctx.files), domains and rules — so a
 * change to any of them busts the cache and no stale bundle is served.
 */
function bundleCacheKey(ctx: AnalysisContext, req: BundleRequest): string {
  const h = createHash("sha256");
  h.update(req.task);
  h.update("\0");
  h.update([...(req.domainHints ?? [])].sort().join(","));
  h.update("\0");
  h.update(filesContentKey(ctx.files));
  h.update("\0");
  for (const c of ctx.specClauses ?? []) {
    h.update(`${c.id}|${c.heading ?? ""}|${c.text ?? ""}\0`);
  }
  h.update("\0");
  for (const d of ctx.domains ?? []) {
    h.update(`${d.domain}|${[...d.implementors].sort().join(",")}\0`);
  }
  h.update("\0");
  for (const r of ctx.rules ?? []) h.update(`${r.id}\0`);
  return versionedKey(h.digest("hex"), "bundle", BUNDLE_CACHE_VERSION);
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
  /**
   * Reused embedding cache (content-keyed per text) so repeated verify calls
   * skip re-embedding unchanged domain-card texts. Defaults to a process-shared
   * store (sharedEmbeddingCache) when providers are present and this is omitted.
   */
  embeddingCache?: CacheStore<CachedVector>;
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
    // Cache embeddings per text: the stable card texts are reused across verifies
    // and only the changed code is re-embedded (matters for a networked embedder).
    embed = createCachedEmbedder(
      opts.providers.embed,
      opts.embeddingCache ?? sharedEmbeddingCache(),
      opts.providers.embedModelId,
    );
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
