/**
 * src/adapters/mcp.ts -- T30 + multi-project: MCP server adapter.
 *
 * Exposes the original 4 Anatomia tools plus 3 project-management tools:
 *   anatomia.context          -- assemble a ContextBundle for a task
 *   anatomia.verify           -- run the 5-gate verify pipeline on a diff
 *   anatomia.where            -- resolve landing point(s) for a task
 *   anatomia.impact           -- BFS impact radius from an anchor
 *   anatomia.projects.list    -- list registered projects (+ selected id)
 *   anatomia.projects.add     -- register a project (name + rootPath)
 *   anatomia.projects.analyze -- analyze a project (cache-aware) and report stats
 *
 * Project-awareness: the original 4 tools take an optional `project` (id) arg.
 * When a ProjectManager is wired, the tool operates on that project context
 * (defaulting to the selected project). When constructed with a bare
 * AnalysisContext (legacy / single-project), the `project` arg is ignored and
 * behaviour is unchanged.
 *
 * SRP: MCP wiring only. Analysis via core.ts; project lifecycle via ProjectManager.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  buildContextBundle,
  buildVerdict,
  getImpactRadius,
} from "../core.js";
import { resolveLanding } from "../supply/landing.js";
import { ProjectManager } from "../project/manager.js";
import { resolveProviders } from "../providers/index.js";
import { createCardCache } from "../domains/card.js";
import type { CardCache, DomainCard } from "../domains/card.js";
import { createFileStore } from "../cache/file-store.js";
import { instrumentStore } from "../cache/instrumented.js";
import { resolveTranscript } from "../cache/transcript.js";
import type { CacheTranscript } from "../cache/transcript.js";
import type { AnalysisContext, Landing } from "../core.js";
import type { ContextBundle, Verdict, AnchorId } from "../types.js";
import type { Project } from "../project/types.js";
import type { Providers } from "../providers/index.js";

// ---------------------------------------------------------------------------
// Context resolution: either a fixed ctx (legacy) or a ProjectManager.
// ---------------------------------------------------------------------------

/**
 * Resolves the AnalysisContext a tool should operate on. A bare AnalysisContext
 * yields a resolver that ignores `project` (single-project mode). A
 * ProjectManager yields a resolver that analyzes the requested/selected project.
 */
export interface ContextSource {
  resolve(project?: string): Promise<AnalysisContext>;
  manager?: ProjectManager;
}

export function contextSourceFrom(src: AnalysisContext | ProjectManager): ContextSource {
  if (src instanceof ProjectManager) {
    return {
      manager: src,
      resolve: (project?: string) => src.getContext(project),
    };
  }
  return { resolve: async () => src };
}

// ---------------------------------------------------------------------------
// Plain handler functions (testable without MCP transport)
// ---------------------------------------------------------------------------

export interface ToolHandlers {
  "anatomia.context"(args: { task: string; project?: string }): Promise<ContextBundle>;
  "anatomia.verify"(args: { diff: string; project?: string }): Promise<Verdict>;
  "anatomia.where"(args: { task: string; project?: string }): Promise<{ landings: Landing[] }>;
  "anatomia.impact"(args: { anchor: string; project?: string }): Promise<{ anchors: string[] }>;
  "anatomia.projects.list"(): Promise<{ projects: Project[]; selected: string | null }>;
  "anatomia.projects.add"(args: {
    name: string;
    rootPath: string;
  }): Promise<{ project: Project }>;
  "anatomia.projects.analyze"(args: {
    project?: string;
  }): Promise<{ project: string; files: number; functions: number; cacheHit: boolean }>;
}

/**
 * Cache measurement context: the shared transcript + this process's session id.
 * Threaded from main() so the card cache and the LLM-usage hook record into the
 * same JSONL log (see cache/transcript.ts).
 */
export interface CacheObservability {
  transcript: CacheTranscript;
  session: string;
  /** Resolved LLM model id, stamped on get events (diagnostic). */
  model?: string;
}

/**
 * Resolve the card cache: a persistent file store under ANATOMIA_CACHE_DIR when
 * set (shared across invocations / sessions / repos), else in-memory. When `obs`
 * is present the store is wrapped so every get records a hit/miss event.
 */
function resolveCardCache(obs?: CacheObservability): CardCache {
  const dir = process.env["ANATOMIA_CACHE_DIR"];
  const base: CardCache = dir ? createFileStore<DomainCard>(dir) : createCardCache();
  if (!obs) return base;
  return instrumentStore(base, {
    ns: "card",
    transcript: obs.transcript,
    session: obs.session,
    model: obs.model,
  }).store;
}

export function createHandlers(
  src: AnalysisContext | ProjectManager,
  providers?: Providers,
  obs?: CacheObservability,
): ToolHandlers {
  const source = contextSourceFrom(src);
  // Reused across verify calls so unchanged domains skip LLM card distillation.
  // ANATOMIA_CACHE_DIR opts into a persistent, content-addressed store shared
  // across MCP invocations / sessions / repos; unset = hermetic in-memory.
  const cardCache = resolveCardCache(obs);
  const verifyOpts = providers ? { providers, cardCache } : undefined;

  return {
    async "anatomia.context"({ task, project }) {
      const ctx = await source.resolve(project);
      return buildContextBundle(ctx, { task });
    },

    async "anatomia.verify"({ diff, project }) {
      const ctx = await source.resolve(project);
      return buildVerdict(ctx, diff, undefined, verifyOpts);
    },

    async "anatomia.where"({ task }) {
      const stubDetector = async () => ["general"];
      const stubLayerRules = { layerFor: () => null };
      const stubSiblings = async () => [];
      const landings = await resolveLanding(
        { description: task },
        stubDetector,
        stubLayerRules,
        stubSiblings,
      );
      return { landings };
    },

    async "anatomia.impact"({ anchor, project }) {
      const ctx = await source.resolve(project);
      const anchors = await getImpactRadius(ctx, anchor as AnchorId);
      return { anchors };
    },

    async "anatomia.projects.list"() {
      const mgr = requireManager(source);
      return { projects: mgr.list(), selected: mgr.selected };
    },

    async "anatomia.projects.add"({ name, rootPath }) {
      const mgr = requireManager(source);
      const project = await mgr.addProject({ name, rootPath });
      return { project };
    },

    async "anatomia.projects.analyze"({ project }) {
      const mgr = requireManager(source);
      const id = mgr.resolveId(project);
      const before = mgr.cache.hits;
      const ctx = await mgr.analyzeProject(id);
      const cacheHit = mgr.cache.hits > before;
      return { project: id, files: ctx.files.length, functions: ctx.functions.length, cacheHit };
    },
  };
}

function requireManager(source: ContextSource): ProjectManager {
  if (!source.manager) {
    throw new Error(
      "Project tools require a ProjectManager-backed server (single-project mode has no registry).",
    );
  }
  return source.manager;
}

// ---------------------------------------------------------------------------
// MCP server class
// ---------------------------------------------------------------------------

export class AnatomiaServer {
  readonly server: McpServer;
  private readonly handlers: ToolHandlers;
  private readonly hasManager: boolean;

  constructor(
    src: AnalysisContext | ProjectManager,
    providers?: Providers,
    obs?: CacheObservability,
  ) {
    this.handlers = createHandlers(src, providers, obs);
    this.hasManager = src instanceof ProjectManager;
    this.server = new McpServer({ name: "anatomia", version: "0.1.0" });
    this._registerTools();
  }

  private _registerTools(): void {
    const h = this.handlers;

    this.server.tool(
      "anatomia.context",
      "Assemble a deterministic ContextBundle for an AI coding task.",
      {
        task: z.string().describe("Free-text task description"),
        project: z.string().optional().describe("Project id (defaults to selected)"),
      },
      async ({ task, project }) => {
        const result = await h["anatomia.context"]({ task, project });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    );

    this.server.tool(
      "anatomia.verify",
      "Run the 5-gate architectural verify pipeline on a code diff.",
      {
        diff: z.string().describe("C++/C#/TS source diff to verify"),
        project: z.string().optional().describe("Project id (defaults to selected)"),
      },
      async ({ diff, project }) => {
        const result = await h["anatomia.verify"]({ diff, project });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    );

    this.server.tool(
      "anatomia.where",
      "Resolve the landing point(s) for a coding task.",
      {
        task: z.string().describe("Task description to find landing for"),
        project: z.string().optional().describe("Project id (defaults to selected)"),
      },
      async ({ task, project }) => {
        const result = await h["anatomia.where"]({ task, project });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    );

    this.server.tool(
      "anatomia.impact",
      "Return BFS-reachable anchors from a given code anchor (impact radius).",
      {
        anchor: z.string().describe("AnchorId to start BFS from"),
        project: z.string().optional().describe("Project id (defaults to selected)"),
      },
      async ({ anchor, project }) => {
        const result = await h["anatomia.impact"]({ anchor, project });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    );

    // Project-management tools are only registered when a registry is present.
    if (!this.hasManager) return;

    this.server.tool(
      "anatomia.projects.list",
      "List registered projects and the currently selected project id.",
      {},
      async () => {
        const result = await h["anatomia.projects.list"]();
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    );

    this.server.tool(
      "anatomia.projects.add",
      "Register a project by name and root path.",
      {
        name: z.string().describe("Human-readable project name"),
        rootPath: z.string().describe("Absolute path to the project root"),
      },
      async ({ name, rootPath }) => {
        const result = await h["anatomia.projects.add"]({ name, rootPath });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    );

    this.server.tool(
      "anatomia.projects.analyze",
      "Analyze a project (cache-aware) and report file/function counts.",
      { project: z.string().optional().describe("Project id (defaults to selected)") },
      async ({ project }) => {
        const result = await h["anatomia.projects.analyze"]({ project });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    );
  }

  /** Connect this server to a transport and start listening. */
  async connect(transport: StdioServerTransport): Promise<void> {
    await this.server.connect(transport);
  }
}

export function createServer(
  src: AnalysisContext | ProjectManager,
  providers?: Providers,
  obs?: CacheObservability,
): AnatomiaServer {
  return new AnatomiaServer(src, providers, obs);
}

// ---------------------------------------------------------------------------
// Production main (stdio)
// ---------------------------------------------------------------------------

/**
 * Entry point for production use.
 *
 * With no persisted registry: register cwd as the default project so existing
 * single-project usage keeps working, but with project tools available.
 */
export async function main(repoPath = process.cwd()): Promise<void> {
  const mgr = await ProjectManager.load();
  if (mgr.list().length === 0) {
    await mgr.addProject({ name: "default", rootPath: repoPath });
  }

  // Cache measurement: ANATOMIA_CACHE_LOG opts in. The same transcript receives
  // both card-cache hit/miss events and per-call LLM token usage, so cache-stats
  // can correlate hits with the calls they avoided.
  const obs = resolveTranscript();
  const providers = resolveProviders(undefined, {
    onUsage: (usage) =>
      obs.transcript.record({
        kind: "llm",
        ts: Date.now(),
        session: obs.session,
        model: providers.llmModelId,
        usage,
      }),
  });

  // Diagnostics to stderr (stdout is the MCP transport — must stay clean).
  console.error(`[anatomia/mcp] providers: ${providers.describe()}`);
  if (obs.enabled) {
    console.error(
      `[anatomia/mcp] cache measurement ON -> ${process.env["ANATOMIA_CACHE_LOG"]} (session ${obs.session})`,
    );
  }
  const cacheObs = obs.enabled
    ? { transcript: obs.transcript, session: obs.session, model: providers.llmModelId }
    : undefined;
  const srv = createServer(mgr, providers, cacheObs);
  const transport = new StdioServerTransport();
  await srv.connect(transport);
}