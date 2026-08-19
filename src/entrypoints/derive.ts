/**
 * src/entrypoints/derive.ts — Entry traversal → product graph.
 *
 * Walks the shared traversal (graph/traverse.ts) once per entry, then folds the
 * per-entry trees into ONE product graph: every reached symbol carries the set
 * of entries that reach it plus its per-entry distance/parent, every tree edge
 * carries the entries it is on, and every symbol no entry reaches is listed as
 * `unrooted` rather than quietly attached somewhere.
 *
 * The frontier is the other half of honesty: a leaf whose outgoing call was
 * DROPPED by static resolution is not "the end of the program", it is the end of
 * what static analysis can see. Those drops (types.ts UnresolvedCall) ride along
 * on the node so "does not reach" and "cannot follow" never look alike.
 *
 * Deterministic: no LLM, no clock, every list sorted.
 *
 * SRP: derivation only. Detection in detect.ts, persistence in knowledge/entrypoint/.
 */

import { createHash } from "node:crypto";
import { relative } from "node:path";
import type { AnalysisContext } from "../core.js";
import { canonicalJson } from "../knowledge/canonical-json.js";
import { reachFrom } from "../graph/traverse.js";
import type { AnchorId, UnresolvedCall } from "../types.js";
import type {
  EntryPointColoring,
  EntryPointDiagnostic,
  EntryPointEdge,
  EntryPointFrontier,
  EntryPointGraph,
  EntryPointManifest,
  EntryPointNode,
  EntryPointSummary,
  UnrootedSymbol,
} from "./types.js";

export interface DeriveEntryPointGraphInput {
  projectId: string;
  sourceRevision: string;
  context: AnalysisContext;
  manifest: EntryPointManifest;
  /** Domain colouring (read-only). Absent → uncoloured nodes. */
  coloring?: EntryPointColoring;
}

interface SymbolFacts {
  name: string;
  path: string;
}

function frontierOf(unresolved: readonly UnresolvedCall[]): Map<AnchorId, EntryPointFrontier[]> {
  const byAnchor = new Map<AnchorId, EntryPointFrontier[]>();
  for (const record of unresolved) {
    const list = byAnchor.get(record.from) ?? byAnchor.set(record.from, []).get(record.from)!;
    list.push({
      calleeName: record.calleeName,
      ...(record.receiverType ? { receiverType: record.receiverType } : {}),
      reason: record.reason,
    });
  }
  for (const list of byAnchor.values()) {
    list.sort((left, right) =>
      left.calleeName.localeCompare(right.calleeName)
      || (left.receiverType ?? "").localeCompare(right.receiverType ?? "")
      || left.reason.localeCompare(right.reason));
  }
  return byAnchor;
}

function symbolFacts(context: AnalysisContext): Map<AnchorId, SymbolFacts> {
  const facts = new Map<AnchorId, SymbolFacts>();
  for (const fn of context.functions) {
    if (!fn.id) continue;
    facts.set(fn.id, {
      name: fn.name,
      path: relative(context.repoPath, fn.sourceRange.filePath).replace(/\\/g, "/"),
    });
  }
  return facts;
}

/** Derive the whole entry-point trace graph. Same input → byte-identical output. */
export async function deriveEntryPointGraph(
  input: DeriveEntryPointGraphInput,
): Promise<EntryPointGraph> {
  const { context, manifest } = input;
  const traversal = manifest.config.traversal;
  const facts = symbolFacts(context);
  const frontiers = frontierOf(context.graph.raw.unresolved ?? []);
  const diagnostics: EntryPointDiagnostic[] = [...manifest.diagnostics];

  const nodes = new Map<AnchorId, EntryPointNode>();
  const edges = new Map<string, EntryPointEdge>();
  const summaries: EntryPointSummary[] = [];

  for (const entry of manifest.entries) {
    const { steps, depthLimited } = await reachFrom(context.graph, [entry.symbol.anchor], {
      edgeKinds: traversal.edgeKinds,
      maxDepth: traversal.maxDepth,
    });
    if (depthLimited) {
      diagnostics.push({
        kind: "max-depth",
        message: `entry ${entry.symbol.name} hit the traversal depth cap (${traversal.maxDepth})`,
        entryId: entry.id,
      });
    }

    const business = new Set<string>();
    const program = new Set<string>();
    let maxDistance = 0;
    let frontierCount = 0;

    for (const [anchor, step] of [...steps.entries()].sort((left, right) => String(left[0]).localeCompare(String(right[0])))) {
      const fact = facts.get(anchor);
      const node = nodes.get(anchor) ?? {
        anchor: String(anchor),
        name: fact?.name ?? String(anchor),
        path: fact?.path ?? "",
        reachedFrom: [],
        distance: {},
        via: {},
        frontier: frontiers.get(anchor) ?? [],
      };
      const owner = input.coloring?.owner.get(anchor);
      if (owner !== undefined) node.owner = owner;
      const programDomain = input.coloring?.programDomain.get(anchor);
      if (programDomain !== undefined) node.programDomain = programDomain;
      node.reachedFrom.push(entry.id);
      node.distance[entry.id] = step.distance;
      if (step.via !== null) node.via[entry.id] = String(step.via);
      nodes.set(anchor, node);

      if (owner !== undefined) business.add(owner);
      if (programDomain !== undefined) program.add(programDomain);
      maxDistance = Math.max(maxDistance, step.distance);
      frontierCount += node.frontier.length;

      if (step.via !== null) {
        const key = `${String(step.via)}\u0000${String(anchor)}`;
        const edge = edges.get(key) ?? {
          from: String(step.via), to: String(anchor), kind: step.viaKind ?? "calls", onTreeOf: [],
        };
        edge.onTreeOf.push(entry.id);
        edges.set(key, edge);
      }
    }

    summaries.push({
      id: entry.id,
      classes: entry.classes,
      detector: entry.detector,
      symbol: entry.symbol,
      ...(entry.phase ? { phase: entry.phase } : {}),
      reached: steps.size,
      maxDistance,
      activatesDomains: { business: [...business].sort(), program: [...program].sort() },
      frontierCount,
    });
  }

  const unrooted: UnrootedSymbol[] = [...facts.entries()]
    .filter(([anchor]) => !nodes.has(anchor))
    .map(([anchor, fact]) => ({ anchor: String(anchor), name: fact.name, path: fact.path }))
    .sort((left, right) => left.anchor.localeCompare(right.anchor));

  const sortedNodes = [...nodes.values()]
    .map((node) => ({ ...node, reachedFrom: [...new Set(node.reachedFrom)].sort() }))
    .sort((left, right) => left.anchor.localeCompare(right.anchor));
  const sortedEdges = [...edges.values()]
    .map((edge) => ({ ...edge, onTreeOf: [...new Set(edge.onTreeOf)].sort() }))
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));

  const definitionFingerprint = `sha256:${createHash("sha256")
    .update(canonicalJson({ entries: manifest.entries, config: manifest.config }), "utf8")
    .digest("hex")}`;

  return {
    schemaVersion: 1,
    projectId: input.projectId,
    sourceRevision: input.sourceRevision,
    definitionFingerprint,
    entries: summaries.sort((left, right) => left.id.localeCompare(right.id)),
    nodes: sortedNodes,
    edges: sortedEdges,
    unrooted,
    diagnostics: diagnostics.sort((left, right) =>
      left.kind.localeCompare(right.kind)
      || (left.entryId ?? "").localeCompare(right.entryId ?? "")
      || left.message.localeCompare(right.message)),
  };
}
