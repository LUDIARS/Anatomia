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
 *     {path, size, mtimeMs}. Same files + same mtimes ⇒ same fingerprint ⇒
 *     cached context is valid (no parse, no hash, no graph build).
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

import { createHash } from "node:crypto";
import { stat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectFilesByExt } from "../fs/walk.js";
import { buildRepoNode } from "../dag/merkle.js";
import { cacheRoot } from "./store.js";
import type { AnalysisContext } from "../core.js";

/** Source extensions whose presence/mtime define a project's fingerprint. */
const SOURCE_EXTS = new Set([".cpp", ".h", ".cs", ".ts", ".tsx", ".md"]);

/** One file's identity contribution to the fingerprint. */
interface FileStamp {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Persisted, serializable cache snapshot for a project. */
export interface CacheSnapshot {
  version: 1;
  projectId: string;
  /** Pre-analysis fingerprint (files + mtimes). */
  fingerprint: string;
  /** Post-analysis Merkle hash of the DAG (repo node over file hashes). */
  merkleHash: string;
  fileCount: number;
  functionCount: number;
  analyzedAt: string;
}

/** A cached analysis entry held in memory. */
export interface CacheEntry {
  fingerprint: string;
  merkleHash: string;
  ctx: AnalysisContext;
}

/**
 * Compute a cheap pre-analysis fingerprint of a project's source tree.
 * Walks the root once collecting {path, size, mtimeMs} for source/spec files,
 * then hashes the sorted stamps. No file contents are read; no parsing.
 */
export async function computeFingerprint(rootPath: string): Promise<string> {
  const stamps = await collectStamps(rootPath);
  stamps.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash("sha256");
  for (const s of stamps) {
    h.update(s.path.replace(/\\/g, "/"));
    h.update("\0");
    h.update(String(s.size));
    h.update("\0");
    h.update(String(Math.floor(s.mtimeMs)));
    h.update("\n");
  }
  return h.digest("hex").slice(0, 32);
}

async function collectStamps(root: string): Promise<FileStamp[]> {
  const out: FileStamp[] = [];
  // Directory-pruning walk (fs/walk.ts): node_modules/dist/.git/.anatomia are
  // never descended into, so the fingerprint scan is O(source tree) not O(repo).
  const paths = await collectFilesByExt(root, SOURCE_EXTS);
  for (const full of paths) {
    try {
      const st = await stat(full);
      out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // file vanished between walk and stat — ignore.
    }
  }
  return out;
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

  /** Record a freshly-analyzed context and persist its disk snapshot. */
  async put(
    projectId: string,
    fingerprint: string,
    ctx: AnalysisContext,
  ): Promise<CacheSnapshot> {
    const merkleHash = merkleHashOf(ctx);
    this.mem.set(projectId, { fingerprint, merkleHash, ctx });
    const snap: CacheSnapshot = {
      version: 1,
      projectId,
      fingerprint,
      merkleHash,
      fileCount: ctx.files.length,
      functionCount: ctx.functions.length,
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
}
