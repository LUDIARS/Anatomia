/**
 * src/project/manager.ts — Project manager: registry + cache + analyze().
 *
 * SRP: orchestrate the lifecycle of analyzed projects. Holds a ProjectRegistry
 * (identity/CRUD), an AnalysisCache (incremental reuse), and lazily runs
 * core.analyze() per project. Does NOT do identity math (registry.ts) or cache
 * mechanics (cache.ts) itself.
 *
 * Re-analyzing an unchanged project reuses the cache (fingerprint match) so the
 * expensive parse/hash/graph work is skipped — assertable via `cache.hits`.
 */

import { analyze } from "../core.js";
import type { AnalysisContext, AnalyzeOptions } from "../core.js";
import { ProjectRegistry } from "./registry.js";
import { AnalysisCache, computeFingerprint, summarize } from "./cache.js";
import type { SummaryCounts } from "./cache.js";
import { loadRegistry, saveRegistry } from "./store.js";
import type { Project, ProjectInput } from "./types.js";
import { createMemoryStore, type CacheStore } from "../cache/store.js";
import { instrumentStore } from "../cache/instrumented.js";
import { resolveTranscript, type CacheTranscript } from "../cache/transcript.js";
import type { DetectionResult } from "../domains/detect.js";
import type { CodeGraph } from "../graph/build.js";
import { vgWrite, withVgSpan } from "../obs/vestigium.js";

export interface ProjectManagerOptions {
  /** Anatomia home dir (projects.json + cache/). Default: ANATOMIA_HOME or <cwd>/.anatomia. */
  homeDir?: string;
  /** Forwarded to analyze() (quiet / pluginDir). */
  analyzeOptions?: AnalyzeOptions;
}

export class ProjectManager {
  readonly registry: ProjectRegistry;
  readonly cache: AnalysisCache;
  /**
   * Process-shared domain-detection cache (memory), instrumented so its hit/miss
   * lands in the cache transcript (ns "detection"). Reused across this manager's
   * analyze() calls so a fingerprint miss that left the code identical (spec /
   * config edit) skips re-detection. See domains/cache.ts.
   */
  private readonly detectionCache: CacheStore<DetectionResult[]>;
  /**
   * Process-shared built-graph cache (memory), instrumented (ns "graph"). Reused
   * across analyze() calls so a fingerprint miss that left the code identical
   * skips edge extraction + graph build — the largest uncached slice.
   */
  private readonly graphCache: CacheStore<CodeGraph>;
  /** Cache transcript + session, resolved once from ANATOMIA_CACHE_LOG. */
  private readonly transcript: CacheTranscript;
  private readonly session: string;
  private readonly homeDir?: string;
  private readonly analyzeOptions: AnalyzeOptions;
  /** Project ids with an in-flight background revalidation (SWR de-dup). */
  private readonly revalidating = new Set<string>();

  constructor(registry?: ProjectRegistry, options: ProjectManagerOptions = {}) {
    this.registry = registry ?? new ProjectRegistry();
    this.homeDir = options.homeDir;
    this.analyzeOptions = options.analyzeOptions ?? {};
    const obs = resolveTranscript();
    this.transcript = obs.transcript;
    this.session = obs.session;
    this.detectionCache = instrumentStore(createMemoryStore<DetectionResult[]>(), {
      ns: "detection", transcript: this.transcript, session: this.session,
    }).store;
    this.graphCache = instrumentStore(createMemoryStore<CodeGraph>(), {
      ns: "graph", transcript: this.transcript, session: this.session,
    }).store;
    this.cache = new AnalysisCache(this.homeDir, { transcript: this.transcript, session: this.session });
    vgWrite("debug", "project manager init", {
      projects: this.registry.list().length,
      home_dir: this.homeDir ?? null,
    });
  }

  /** Build a manager with the registry loaded from disk (projects.json). */
  static async load(options: ProjectManagerOptions = {}): Promise<ProjectManager> {
    const registry = await loadRegistry(options.homeDir);
    return new ProjectManager(registry, options);
  }

  /** Persist the registry to disk. */
  async save(): Promise<string> {
    const path = await saveRegistry(this.registry, this.homeDir);
    vgWrite("debug", "project registry saved", { projects: this.registry.list().length });
    return path;
  }

  // ── registry passthrough ───────────────────────────────────────────────

  /** Register a project and persist the registry. */
  async addProject(input: ProjectInput): Promise<Project> {
    const p = this.registry.add(input);
    await this.save();
    vgWrite("info", "project added", { project: p.id, name: p.name });
    return p;
  }

  /** Remove a project, drop its cache entry, and persist. */
  async removeProject(id: string): Promise<boolean> {
    const ok = this.registry.remove(id);
    if (ok) {
      this.cache.invalidate(id);
      await this.save();
      vgWrite("info", "project removed", { project: id });
    }
    return ok;
  }

  list(): Project[] {
    return this.registry.list();
  }

  get(id: string): Project | undefined {
    return this.registry.get(id);
  }

  /** Currently selected project id (or null). */
  get selected(): string | null {
    return this.registry.selected;
  }

  /** Select the active project. */
  select(id: string): void {
    this.registry.select(id);
    vgWrite("info", "project selected", { project: id });
  }

  /**
   * Resolve a project id, defaulting to the selected one. Throws if neither the
   * given id nor a selection resolves to a registered project.
   */
  resolveId(id?: string): string {
    const target = id ?? this.registry.selected;
    if (!target) {
      throw new Error("ProjectManager: no project specified and none selected");
    }
    if (!this.registry.has(target)) {
      throw new Error(`ProjectManager: unknown project "${target}"`);
    }
    return target;
  }

  // ── analysis ───────────────────────────────────────────────────────────

  /**
   * Analyze a project, reusing the incremental cache when the source tree is
   * unchanged (fingerprint match → analyze() is skipped). Returns the context.
   */
  async analyzeProject(id?: string): Promise<AnalysisContext> {
    const projectId = this.resolveId(id);
    const project = this.registry.get(projectId)!;
    vgWrite("info", "project analyze requested", { project: projectId, name: project.name });
    const fingerprint = await computeFingerprint(project.rootPath, {
      configDirs: configDirsOf(project),
    });
    return this.analyzeWith(projectId, project, fingerprint);
  }

  /** Resolve a context for a project whose fingerprint is already computed. */
  private async analyzeWith(
    projectId: string,
    project: Project,
    fingerprint: string,
  ): Promise<AnalysisContext> {
    const cached = this.cache.getIfFresh(projectId, fingerprint);
    if (cached) {
      vgWrite("info", "project analysis cache hit", { project: projectId });
      return cached;
    }
    vgWrite("info", "project analysis cache miss", { project: projectId });

    const opts: AnalyzeOptions = {
      ...this.analyzeOptions,
      pluginDir: project.ontologyDir ?? this.analyzeOptions.pluginDir,
      specDirs: project.specDirs ?? this.analyzeOptions.specDirs,
      // Fingerprint changed → some file changed. Hand analyze() the prior
      // FileNodes so it only re-parses the ones whose content actually moved;
      // unchanged files are reused from the last (in-memory) context.
      priorFiles: this.cache.lastFiles(projectId),
      // Reuse domain detection when code identity + ontology are unchanged
      // (e.g. a spec/config-only edit that busts the fingerprint).
      detectionCache: this.detectionCache,
      // Reuse the built graph on the same code-unchanged path.
      graphCache: this.graphCache,
      // Per-file reuse hit/miss → transcript (ns "perfile").
      transcript: this.transcript,
      session: this.session,
    };
    const ctx = await withVgSpan("project.analyze", {
      project: projectId,
      name: project.name,
    }, () => analyze(project.rootPath, opts));
    await this.cache.put(projectId, fingerprint, ctx);
    vgWrite("info", "project analysis cached", {
      project: projectId,
      files: ctx.files.length,
      functions: ctx.functions.length,
    });
    return ctx;
  }

  /**
   * First-view summary counts for a project, optimised for the project list's
   * first paint. Three tiers, cheapest first:
   *   1. live in-memory context (fingerprint match) → summarise directly;
   *   2. persisted snapshot whose fingerprint still matches the source →
   *      served from disk WITHOUT re-analysis (the restart fast path);
   *   3. changed / never-analysed → full analyze(), then summarise.
   * Only tier 3 pays for parsing + graph build, so an unchanged workspace
   * repaints from cache after a fingerprint walk alone.
   *
   * `{ stale: true }` switches to STALE-WHILE-REVALIDATE: when a persisted
   * snapshot exists it is returned immediately WITHOUT even the fingerprint
   * stat-walk (which is itself the dominant first-paint cost on a many-repo
   * workspace), and a background revalidation refreshes the cache so the NEXT
   * call serves fresh counts. With no snapshot yet, it falls back to the normal
   * (blocking) tiers so the first-ever view is still correct.
   */
  async summary(id?: string, opts: { stale?: boolean } = {}): Promise<SummaryCounts> {
    const projectId = this.resolveId(id);
    const project = this.registry.get(projectId)!;

    if (opts.stale) {
      const snap = await this.cache.readSnapshot(projectId);
      if (snap?.summary?.domainHealth) {
        vgWrite("debug", "project summary stale snapshot hit", { project: projectId });
        this.revalidateInBackground(projectId, project);
        return snap.summary;
      }
      if (snap?.summary) {
        vgWrite("debug", "project summary stale snapshot missing domain health", { project: projectId });
      }
      // No snapshot yet → fall through to the blocking path (first analyze).
    }

    const fingerprint = await computeFingerprint(project.rootPath, {
      configDirs: configDirsOf(project),
    });

    const cached = this.cache.getIfFresh(projectId, fingerprint);
    if (cached) {
      vgWrite("debug", "project summary memory cache hit", { project: projectId });
      return summarize(cached);
    }

    const snap = await this.cache.readSnapshot(projectId);
    if (snap && snap.fingerprint === fingerprint && snap.summary?.domainHealth) {
      vgWrite("debug", "project summary disk snapshot hit", { project: projectId });
      return snap.summary;
    }
    if (snap && snap.fingerprint === fingerprint && snap.summary) {
      vgWrite("debug", "project summary disk snapshot missing domain health", { project: projectId });
    }

    vgWrite("debug", "project summary cache miss", { project: projectId });
    return summarize(await this.analyzeWith(projectId, project, fingerprint));
  }

  /**
   * Background freshness check for the SWR summary path: recompute the
   * fingerprint and, when the cache is stale, re-analyze so the NEXT summary()
   * serves fresh counts. Fire-and-forget but de-duplicated per project and
   * fully self-contained (it never rejects) so a failure can't surface as an
   * unhandled rejection or crash the warm server.
   */
  private revalidateInBackground(projectId: string, project: Project): void {
    if (this.revalidating.has(projectId)) return;
    this.revalidating.add(projectId);
    void (async () => {
      try {
        vgWrite("debug", "project summary revalidate start", { project: projectId });
        const fingerprint = await computeFingerprint(project.rootPath, {
          configDirs: configDirsOf(project),
        });
        if (this.cache.getIfFresh(projectId, fingerprint)) return; // in-memory fresh
        const snap = await this.cache.readSnapshot(projectId);
        if (snap && snap.fingerprint === fingerprint) return; // disk already fresh
        await this.analyzeWith(projectId, project, fingerprint);
        vgWrite("debug", "project summary revalidate done", { project: projectId });
      } catch (err) {
        vgWrite("warn", "project summary revalidate failed", {
          project: projectId,
          error: String(err),
        });
        // Best-effort: the next summary() call retries; surface nothing.
      } finally {
        this.revalidating.delete(projectId);
      }
    })();
  }

  /**
   * Get the analyzed context for a project, analyzing on first request and
   * reusing the cache thereafter. Equivalent to analyzeProject() but reads more
   * naturally at call sites that just want "the context for this project".
   */
  async getContext(id?: string): Promise<AnalysisContext> {
    return this.analyzeProject(id);
  }

  /**
   * The current source fingerprint for a project (folds rootPath + config dirs).
   * Exposed so callers that content-key derived results on the source — e.g. the
   * integral path cache — invalidate naturally when the tree changes.
   */
  async fingerprint(id?: string): Promise<string> {
    const projectId = this.resolveId(id);
    const project = this.registry.get(projectId)!;
    return computeFingerprint(project.rootPath, { configDirs: configDirsOf(project) });
  }

  /**
   * Resolve a fingerprint-keyed derived render artifact (e.g. the graph view's
   * vis-data), building it from the analyzed context only on a cache miss.
   *
   * Restart fast path: the cheap fingerprint walk hits the persisted artifact
   * and returns it WITHOUT re-analysis — analyze() is never called and `build`
   * never runs. This is what keeps opening the panel's graph view on a cold
   * (just-restarted) warm server from re-parsing the entire repo, the path that
   * previously made the web panel fall over on large C++ projects.
   *
   * On a miss (cold disk, or source changed) it analyzes once, builds the
   * artifact, persists it, and returns it.
   */
  async cachedArtifact<T>(
    id: string | undefined,
    name: string,
    build: (ctx: AnalysisContext) => Promise<T>,
  ): Promise<T> {
    const projectId = this.resolveId(id);
    const project = this.registry.get(projectId)!;
    const fingerprint = await computeFingerprint(project.rootPath, {
      configDirs: configDirsOf(project),
    });

    const cached = await this.cache.readArtifact<T>(projectId, name, fingerprint);
    if (cached !== null) {
      vgWrite("debug", "project artifact cache hit", { project: projectId, artifact: name });
      return cached;
    }

    vgWrite("debug", "project artifact cache miss", { project: projectId, artifact: name });
    const ctx = await this.analyzeWith(projectId, project, fingerprint);
    const data = await withVgSpan("project.artifact.build", {
      project: projectId,
      artifact: name,
    }, () => build(ctx));
    await this.cache.writeArtifact(projectId, name, fingerprint, data);
    vgWrite("debug", "project artifact cached", { project: projectId, artifact: name });
    return data;
  }
}

/**
 * The project's config dirs (ontologyDir + specDirs) that feed the fingerprint,
 * so editing an ontology def or an out-of-root spec busts the analysis cache.
 */
function configDirsOf(project: Project): string[] {
  const dirs: string[] = [];
  if (project.ontologyDir) dirs.push(project.ontologyDir);
  if (project.specDirs) dirs.push(...project.specDirs);
  return dirs;
}
