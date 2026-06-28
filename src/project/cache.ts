/**
 * src/project/cache.ts — Incremental analysis cache.
 *
 * STRATEGY (DESIGN §2/§9 — "make the cache a data structure"):
 *
 *   - A project's analyzed result (AnalysisContext) holds live tree-sitter AST
 *     nodes, which are NOT serializable. So the *result* is cached in-memory
 *     (keyed by a content fingerprint) and reused when the project is
 *     re-analyzed and nothing on disk changed → re-analysis is skipped entirely.
 *
 *   - To detect change cheaply WITHOUT re-parsing, we compute a pre-analysis
 *     `fingerprint`: a Merkle-style hash over each source file's
 *     {path, contentHash} (see fingerprint.ts). Same files + same content ⇒ same
 *     fingerprint ⇒ cached context is valid (no parse, no hash, no graph build).
 *     Hashing content (not size/mtime) keeps the cache valid across git
 *     checkouts and fresh worktrees that rewrite mtimes without changing what
 *     the files say.
 *
 *   - After analysis we additionally derive a `merkleHash` from the real DAG
 *     (buildRepoNode over the FileNodes' content hashes) and persist a small
 *     serializable snapshot to `<home>/cache/<projectId>/snapshot.json`. This
 *     survives restarts: a fresh process compares the current fingerprint to the
 *     persisted one to know whether source changed before paying for analysis.
 *
 * The two-tier design mirrors DESIGN §4.1: a function/file edit changes exactly
 * that file's hash (and the repo hash); untouched files keep their hash, so the
 * unchanged-project case is detected without recomputation.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildRepoNode } from "../dag/merkle.js";
import { cacheRoot } from "./store.js";
import type { AnalysisContext } from "../core.js";
import type { FileNode } from "../types.js";

// The pre-analysis fingerprint (content-addressed) lives in fingerprint.ts;
// re-exported here so existing importers keep resolving it from "./cache.js".
export { computeFingerprint } from "./fingerprint.js";

/**
 * First-view summary counts for a project. This is exactly the payload the
 * management panel's project list paints per row, so persisting it lets a cold
 * server answer `/api/projects/:id/summary` from disk without re-analysis.
 */
export interface SummaryCounts {
  files: number;
  functions: number;
  nodes: number;
  edges: number;
  domains: number;
  links: number;
}

/** Persisted, serializable cache snapshot for a project. */
export interface CacheSnapshot {
  version: 1;
  projectId: string;
  /** Pre-analysis fingerprint (files + content hashes; see fingerprint.ts). */
  fingerprint: string;
  /** Post-analysis Merkle hash of the DAG (repo node over file hashes). */
  merkleHash: string;
  fileCount: number;
  functionCount: number;
  /**
   * First-view summary counts. Optional because snapshots written before this
   * field existed lack it — readers must fall back to (re)analysis when absent.
   */
  summary?: SummaryCounts;
  analyzedAt: string;
}

/** A cached analysis entry held in memory. */
export interface CacheEntry {
  fingerprint: string;
  merkleHash: string;
  ctx: AnalysisContext;
}

/**
 * Persisted envelope for a derived render artifact (e.g. the vis-network graph
 * payload). Unlike the AnalysisContext, these artifacts are plain JSON, so they
 * CAN survive a restart on disk. Keyed by the same pre-analysis `fingerprint`,
 * so a stale source tree never serves a stale artifact.
 */
export interface ArtifactEnvelope<T> {
  version: 1;
  fingerprint: string;
  builtAt: string;
  data: T;
}

/**
 * Derive the post-analysis Merkle hash from an AnalysisContext's FileNodes.
 * Reuses buildRepoNode (DAG §4.1). Returns "" when there are no files.
 */
export function merkleHashOf(ctx: AnalysisContext): string {
  const files = ctx.files.filter((f) => f.hash != null);
  if (files.length === 0) return "";
  return buildRepoNode(files).hash;
}

/**
 * Derive the first-view summary counts from an analyzed context. Mirrors what
 * the `/api/projects/:id/summary` route returns; computed once at analyze time
 * and persisted so the first paint never has to traverse the graph again.
 */
export async function summarize(ctx: AnalysisContext): Promise<SummaryCounts> {
  const nodes = await ctx.graph.allNodes();
  let edges = 0;
  for (const n of nodes) {
    edges += (await ctx.graph.edgesFrom(n.id)).length;
  }
  return {
    files: ctx.files.length,
    functions: ctx.functions.length,
    nodes: nodes.length,
    edges,
    domains: (ctx.domains ?? []).length,
    links: (ctx.links ?? []).length,
  };
}

/**
 * In-memory + on-disk incremental analysis cache.
 *
 * `get(id, fingerprint)` returns a cached context only when the fingerprint
 * matches (i.e. the project's source is unchanged). `put(...)` records the
 * context in memory and writes the disk snapshot.
 */
export class AnalysisCache {
  private readonly mem = new Map<string, CacheEntry>();
  private readonly home?: string;

  /** Counts work skipped vs. performed (observability / test assertions). */
  hits = 0;
  misses = 0;
  /** Same, for the derived render-artifact cache (vis-data etc). */
  artifactHits = 0;
  artifactMisses = 0;

  constructor(homeDir?: string) {
    this.home = homeDir;
  }

  /** Return a cached context iff its stored fingerprint equals `fingerprint`. */
  getIfFresh(projectId: string, fingerprint: string): AnalysisContext | null {
    const entry = this.mem.get(projectId);
    if (entry && entry.fingerprint === fingerprint) {
      this.hits++;
      return entry.ctx;
    }
    this.misses++;
    return null;
  }

  /**
   * The last analyzed project's FileNodes keyed by path — even when the
   * fingerprint no longer matches. Feeds analyze()'s per-file reuse so a
   * partial edit only re-parses the files that changed; unchanged files come
   * straight from the prior context's (live, in-memory) FileNodes. Returns
   * undefined when the project has never been analyzed this process.
   */
  lastFiles(projectId: string): Map<string, FileNode> | undefined {
    const entry = this.mem.get(projectId);
    if (!entry) return undefined;
    return new Map(entry.ctx.files.map((f) => [f.path, f]));
  }

  /** Record a freshly-analyzed context and persist its disk snapshot. */
  async put(
    projectId: string,
    fingerprint: string,
    ctx: AnalysisContext,
  ): Promise<CacheSnapshot> {
    const merkleHash = merkleHashOf(ctx);
    this.mem.set(projectId, { fingerprint, merkleHash, ctx });
    const summary = await summarize(ctx);
    const snap: CacheSnapshot = {
      version: 1,
      projectId,
      fingerprint,
      merkleHash,
      fileCount: summary.files,
      functionCount: summary.functions,
      summary,
      analyzedAt: new Date().toISOString(),
    };
    await this.writeSnapshot(projectId, snap);
    return snap;
  }

  /** Drop a project's in-memory cache entry (disk snapshot left as history). */
  invalidate(projectId: string): void {
    this.mem.delete(projectId);
  }

  /** Directory holding a project's persisted snapshot. */
  dirFor(projectId: string): string {
    return join(cacheRoot(this.home), projectId);
  }

  /** Read the persisted snapshot for a project (null when absent/invalid). */
  async readSnapshot(projectId: string): Promise<CacheSnapshot | null> {
    const path = join(this.dirFor(projectId), "snapshot.json");
    try {
      const raw = await readFile(path, "utf8");
      const snap = JSON.parse(raw) as CacheSnapshot;
      return snap && snap.version === 1 ? snap : null;
    } catch {
      return null;
    }
  }

  private async writeSnapshot(projectId: string, snap: CacheSnapshot): Promise<void> {
    const dir = this.dirFor(projectId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "snapshot.json"),
      JSON.stringify(snap, null, 2) + "\n",
      "utf8",
    );
  }

  // ── derived render-artifact cache ─────────────────────────────────────────
  //
  // The graph view's vis-data is expensive to rebuild (metrics + full edge
  // walk) and, before this cache, was recomputed from a freshly-analyzed
  // context on every panel open — which after a warm-server restart meant a
  // full re-parse of the whole repo. These methods persist the *built* JSON
  // payload keyed by fingerprint so a cold server can answer the render route
  // straight from disk, never touching analyze().

  /** Path to a named derived artifact for a project. */
  private artifactPath(projectId: string, name: string): string {
    const safe = name.replace(/[^a-z0-9_-]/gi, "_");
    return join(this.dirFor(projectId), `artifact-${safe}.json`);
  }

  /**
   * Read a fingerprint-matched render artifact. Returns null on miss, on a
   * fingerprint mismatch (source changed since it was built), or when absent.
   */
  async readArtifact<T>(
    projectId: string,
    name: string,
    fingerprint: string,
  ): Promise<T | null> {
    try {
      const raw = await readFile(this.artifactPath(projectId, name), "utf8");
      const env = JSON.parse(raw) as ArtifactEnvelope<T>;
      if (env && env.version === 1 && env.fingerprint === fingerprint) {
        this.artifactHits++;
        return env.data;
      }
    } catch {
      // absent / unreadable / malformed — treat as a miss.
    }
    this.artifactMisses++;
    return null;
  }

  /** Persist a derived render artifact keyed by the current fingerprint. */
  async writeArtifact<T>(
    projectId: string,
    name: string,
    fingerprint: string,
    data: T,
  ): Promise<void> {
    const env: ArtifactEnvelope<T> = {
      version: 1,
      fingerprint,
      builtAt: new Date().toISOString(),
      data,
    };
    const dir = this.dirFor(projectId);
    await mkdir(dir, { recursive: true });
    await writeFile(this.artifactPath(projectId, name), JSON.stringify(env), "utf8");
  }
}
