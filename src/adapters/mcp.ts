/**
 * src/adapters/mcp.ts — T30: MCP server adapter.
 *
 * Exposes 4 Anatomia tools over the Model Context Protocol:
 *   anatomia.context  — assemble a ContextBundle for a task
 *   anatomia.verify   — run the 5-gate verify pipeline on a diff
 *   anatomia.where    — resolve landing point(s) for a task
 *   anatomia.impact   — BFS impact radius from an anchor
 *
 * SRP: MCP wiring only. All analysis via core.ts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  analyze,
  buildContextBundle,
  buildVerdict,
  getImpactRadius,
} from "../core.js";
import { resolveLanding } from "../supply/landing.js";
import type { AnalysisContext, Landing } from "../core.js";
import type { ContextBundle, Verdict, AnchorId } from "../types.js";

// ---------------------------------------------------------------------------
// Plain handler functions (testable without MCP transport)
// ---------------------------------------------------------------------------

export interface ToolHandlers {
  "anatomia.context"(args: { task: string }): Promise<ContextBundle>;
  "anatomia.verify"(args: { diff: string }): Promise<Verdict>;
  "anatomia.where"(args: { task: string }): Promise<{ landings: Landing[] }>;
  "anatomia.impact"(args: { anchor: string }): Promise<{ anchors: string[] }>;
}

export function createHandlers(ctx: AnalysisContext): ToolHandlers {
  return {
    async "anatomia.context"({ task }) {
      return buildContextBundle(ctx, { task });
    },

    async "anatomia.verify"({ diff }) {
      return buildVerdict(ctx, diff);
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

    async "anatomia.impact"({ anchor }) {
      const anchors = await getImpactRadius(ctx, anchor as AnchorId);
      return { anchors };
    },
  };
}

// ---------------------------------------------------------------------------
// MCP server class
// ---------------------------------------------------------------------------

export class AnatomiaServer {
  readonly server: McpServer;
  private readonly handlers: ToolHandlers;

  constructor(ctx: AnalysisContext) {
    this.handlers = createHandlers(ctx);
    this.server = new McpServer({ name: "anatomia", version: "0.1.0" });
    this._registerTools();
  }

  private _registerTools(): void {
    const h = this.handlers;

    this.server.tool(
      "anatomia.context",
      "Assemble a deterministic ContextBundle for an AI coding task.",
      { task: z.string().describe("Free-text task description") },
      async ({ task }) => {
        const result = await h["anatomia.context"]({ task });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    );

    this.server.tool(
      "anatomia.verify",
      "Run the 5-gate architectural verify pipeline on a code diff.",
      { diff: z.string().describe("C++/C# source diff to verify") },
      async ({ diff }) => {
        const result = await h["anatomia.verify"]({ diff });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    );

    this.server.tool(
      "anatomia.where",
      "Resolve the landing point(s) for a coding task.",
      { task: z.string().describe("Task description to find landing for") },
      async ({ task }) => {
        const result = await h["anatomia.where"]({ task });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    );

    this.server.tool(
      "anatomia.impact",
      "Return BFS-reachable anchors from a given code anchor (impact radius).",
      { anchor: z.string().describe("AnchorId to start BFS from") },
      async ({ anchor }) => {
        const result = await h["anatomia.impact"]({ anchor });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    );
  }

  /** Connect this server to a transport and start listening. */
  async connect(transport: StdioServerTransport): Promise<void> {
    await this.server.connect(transport);
  }
}

export function createServer(ctx: AnalysisContext): AnatomiaServer {
  return new AnatomiaServer(ctx);
}

// ---------------------------------------------------------------------------
// Production main (stdio)
// ---------------------------------------------------------------------------

/**
 * Entry point for production use: analyze(repoPath) → connect via stdio.
 * repoPath defaults to process.cwd().
 */
export async function main(repoPath = process.cwd()): Promise<void> {
  const ctx = await analyze(repoPath);
  const srv = createServer(ctx);
  const transport = new StdioServerTransport();
  await srv.connect(transport);
}
