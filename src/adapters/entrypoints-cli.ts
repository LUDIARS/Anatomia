/**
 * src/adapters/entrypoints-cli.ts — `anatomia entrypoints`.
 *
 * Answers "where does this product start, and how far does each way in reach".
 * With `--project` it reads the prepared artifact (no re-analysis, the same
 * contract the panel has); without it, it analyses the path and derives live so
 * an unregistered checkout still gets an answer.
 *
 * The exit code is ALWAYS 0: this is a lens, not a gate (spec/feature/
 * entrypoint-trace-graph.md インタフェース). A stale artifact is reported in the
 * text, not by failing the command.
 *
 * SRP: CLI shaping for the entry-point surface only.
 */

import { analyze } from "../core.js";
import { detectEntryPoints } from "../entrypoints/detect.js";
import { deriveEntryPointGraph } from "../entrypoints/derive.js";
import { buildColoring } from "../entrypoints/coloring.js";
import type { EntryPointGraph } from "../entrypoints/types.js";
import { KnowledgeApplicationService, knowledgePortFromManager } from "../knowledge/application/index.js";
import { ProjectManager } from "../project/manager.js";
import type { CliArgs } from "./cli.js";

/** Everything the formatter needs, from either source. */
interface EntryPointView {
  graph: EntryPointGraph;
  note: string | null;
  stale: boolean;
  staleReasons: string[];
}

function graphFromManifest(manifest: {
  projectId: string;
  sourceRevision: string;
  definitionFingerprint: string;
  entries: EntryPointGraph["entries"];
  graphNodes: EntryPointGraph["nodes"];
  graphEdges: EntryPointGraph["edges"];
  unrooted: EntryPointGraph["unrooted"];
  diagnostics: EntryPointGraph["diagnostics"];
}): EntryPointGraph {
  return {
    schemaVersion: 1,
    projectId: manifest.projectId,
    sourceRevision: manifest.sourceRevision,
    definitionFingerprint: manifest.definitionFingerprint,
    entries: manifest.entries,
    nodes: manifest.graphNodes,
    edges: manifest.graphEdges,
    unrooted: manifest.unrooted,
    diagnostics: manifest.diagnostics,
  };
}

async function loadView(args: CliArgs): Promise<EntryPointView | { error: string }> {
  if (args.project) {
    const manager = await ProjectManager.load();
    const projectId = manager.resolveId(args.project);
    const inspection = await new KnowledgeApplicationService(
      knowledgePortFromManager(manager, projectId),
    ).entrypoints.query();
    if (!inspection.manifest) {
      return { error: `entry-point graph not derived for "${projectId}" — run: anatomia project analyze ${projectId}` };
    }
    return {
      graph: graphFromManifest(inspection.manifest),
      note: inspection.stale ? `STALE: ${inspection.staleReasons.join(", ")}` : null,
      stale: inspection.stale,
      staleReasons: inspection.staleReasons,
    };
  }
  const ctx = await analyze(args.repoPath);
  return {
    graph: await deriveEntryPointGraph({
      projectId: "local",
      sourceRevision: "local",
      context: ctx,
      manifest: await detectEntryPoints(ctx),
      coloring: buildColoring(ctx),
    }),
    note: null,
    stale: false,
    staleReasons: [],
  };
}

/** The reach tree of one entry, resolved by anchor or by symbol name. */
function formatEntryTree(graph: EntryPointGraph, ref: string): string[] {
  const entry = graph.entries.find((candidate) =>
    candidate.id === ref || candidate.symbol.name === ref);
  if (!entry) return [`no entry matches "${ref}"`];
  const rows = graph.nodes
    .filter((node) => node.reachedFrom.includes(entry.id))
    .map((node) => ({ node, distance: node.distance[entry.id] ?? 0 }))
    .sort((left, right) =>
      left.distance - right.distance || left.node.path.localeCompare(right.node.path)
      || left.node.name.localeCompare(right.node.name));
  const lines = [
    `入口 [${entry.classes.join(",")}] ${entry.symbol.name} (${entry.symbol.path}:${entry.symbol.line})`,
    `  reached ${entry.reached} / depth ${entry.maxDistance} / frontier ${entry.frontierCount}`,
  ];
  for (const row of rows) {
    const colours = [row.node.owner, row.node.programDomain].filter(Boolean).join(" / ");
    const via = row.node.via[entry.id];
    lines.push(
      `  ${"·".repeat(Math.min(row.distance, 8))}+${row.distance} ${row.node.name} (${row.node.path})`
      + (via ? `  via ${via}` : "")
      + (colours ? `  [${colours}]` : "")
      + (row.node.frontier.length > 0 ? `  frontier ${row.node.frontier.length}` : ""),
    );
  }
  return lines;
}

function formatUnrooted(graph: EntryPointGraph): string[] {
  if (graph.unrooted.length === 0) return ["未到達シンボル: なし"];
  return [
    `未到達シンボル: ${graph.unrooted.length}`,
    ...graph.unrooted.map((symbol) => `  ${symbol.name} (${symbol.path})`),
  ];
}

function formatFrontier(graph: EntryPointGraph): string[] {
  const rows = graph.nodes.filter((node) => node.frontier.length > 0);
  if (rows.length === 0) return ["追跡断絶点: なし"];
  const lines = [`追跡断絶点: ${rows.reduce((total, node) => total + node.frontier.length, 0)}`];
  for (const node of rows) {
    for (const drop of node.frontier) {
      lines.push(
        `  ${node.name} (${node.path}) → ${drop.calleeName}`
        + (drop.receiverType ? ` on ${drop.receiverType}` : "")
        + `  [${drop.reason}]`,
      );
    }
  }
  return lines;
}

/** The default listing: one row per entry. */
export function formatEntryPointGraph(graph: EntryPointGraph): string[] {
  const lines = [
    `入口: ${graph.entries.length} entries — ${graph.nodes.length} reached, ${graph.unrooted.length} unrooted`,
  ];
  for (const entry of graph.entries) {
    lines.push(
      `  [${entry.classes.join(",")}] ${entry.symbol.name} (${entry.symbol.path}:${entry.symbol.line})`
      + `  reached ${entry.reached} / depth ${entry.maxDistance} / frontier ${entry.frontierCount}`
      + (entry.activatesDomains.business.length > 0
        ? `  domains: ${entry.activatesDomains.business.join(", ")}`
        : ""),
    );
  }
  for (const diagnostic of graph.diagnostics) {
    lines.push(`  ! ${diagnostic.kind}: ${diagnostic.message}`);
  }
  return lines;
}

export async function runEntryPoints(args: CliArgs): Promise<{ exitCode: number; output: string }> {
  let view: EntryPointView;
  try {
    const loaded = await loadView(args);
    if ("error" in loaded) return { exitCode: 0, output: loaded.error };
    view = loaded;
  } catch (error) {
    return { exitCode: 0, output: `entrypoints unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (args.json) {
    return {
      exitCode: 0,
      output: JSON.stringify({ ...view.graph, stale: view.stale, staleReasons: view.staleReasons }, null, 2),
    };
  }

  const lines: string[] = [];
  if (view.note) lines.push(view.note);
  if (args.entryRef) lines.push(...formatEntryTree(view.graph, args.entryRef));
  else if (args.unrooted) lines.push(...formatUnrooted(view.graph));
  else if (args.frontier) lines.push(...formatFrontier(view.graph));
  else lines.push(...formatEntryPointGraph(view.graph));
  return { exitCode: 0, output: lines.join("\n") };
}
