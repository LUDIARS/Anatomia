/**
 * T12 — In-memory implementation of CodeGraphQuery.
 *
 * Backed by the CodeGraph built by build.ts (T11).  All operations are O(1)
 * or O(V+E) at worst and run synchronously, wrapped in resolved promises so
 * the interface remains uniform with the Kuzu implementation.
 */

import type { AnchorId, CodeNode, Edge, EdgeKind } from "../types.js";
import type { CodeGraph } from "./build.js";
import type {
  CodeGraphQuery,
  EdgeFilter,
  FanCounts,
  TraversalOptions,
} from "./query.js";

export class InMemoryCodeGraph implements CodeGraphQuery {
  private readonly graph: CodeGraph;

  constructor(graph: CodeGraph) {
    this.graph = graph;
  }

  // ── Node lookups ─────────────────────────────────────────────────────────

  async getNode(id: AnchorId): Promise<CodeNode | undefined> {
    return this.graph.nodes.get(id);
  }

  async allNodes(): Promise<CodeNode[]> {
    return Array.from(this.graph.nodes.values());
  }

  // ── Neighbour queries ────────────────────────────────────────────────────

  async neighbors(id: AnchorId, kind?: EdgeKind): Promise<CodeNode[]> {
    const edges = this.graph.adjacency.get(id) ?? [];
    const filtered = kind ? edges.filter((e) => e.kind === kind) : edges;
    return filtered
      .map((e) => this.graph.nodes.get(e.to))
      .filter((n): n is CodeNode => n !== undefined);
  }

  async predecessors(id: AnchorId, kind?: EdgeKind): Promise<CodeNode[]> {
    const edges = this.graph.reverseAdjacency.get(id) ?? [];
    const filtered = kind ? edges.filter((e) => e.kind === kind) : edges;
    return filtered
      .map((e) => this.graph.nodes.get(e.from))
      .filter((n): n is CodeNode => n !== undefined);
  }

  // ── Edge queries ─────────────────────────────────────────────────────────

  async edgesFrom(id: AnchorId, kind?: EdgeKind): Promise<Edge[]> {
    const edges = this.graph.adjacency.get(id) ?? [];
    return kind ? edges.filter((e) => e.kind === kind) : [...edges];
  }

  async edgesTo(id: AnchorId, kind?: EdgeKind): Promise<Edge[]> {
    const edges = this.graph.reverseAdjacency.get(id) ?? [];
    return kind ? edges.filter((e) => e.kind === kind) : [...edges];
  }

  async edgesMatching(filter: EdgeFilter): Promise<Edge[]> {
    return this.graph.edges.filter((e) => {
      if (filter.kind && e.kind !== filter.kind) return false;
      if (filter.fromName) {
        const from = this.graph.nodes.get(e.from);
        if (!from || from.name !== filter.fromName) return false;
      }
      if (filter.toName) {
        const to = this.graph.nodes.get(e.to);
        if (!to || to.name !== filter.toName) return false;
      }
      return true;
    });
  }

  // ── Aggregates ───────────────────────────────────────────────────────────

  async fanCounts(id: AnchorId, kind?: EdgeKind): Promise<FanCounts> {
    const outEdges = this.graph.adjacency.get(id) ?? [];
    const inEdges = this.graph.reverseAdjacency.get(id) ?? [];
    const fanOut = kind ? outEdges.filter((e) => e.kind === kind).length : outEdges.length;
    const fanIn = kind ? inEdges.filter((e) => e.kind === kind).length : inEdges.length;
    return { fanIn, fanOut };
  }

  // ── Reachability / traversal ──────────────────────────────────────────────

  async reachable(id: AnchorId, options: TraversalOptions = {}): Promise<CodeNode[]> {
    const { maxDepth = Infinity, kinds, direction = "outgoing" } = options;
    const visited = new Set<AnchorId>();
    const result: CodeNode[] = [];

    const queue: Array<{ id: AnchorId; depth: number }> = [{ id, depth: 0 }];
    visited.add(id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      const nextEdges = this._neighborEdges(current.id, direction);
      const filtered = kinds ? nextEdges.filter((e) => kinds.includes(e.kind)) : nextEdges;

      for (const edge of filtered) {
        const nextId =
          direction === "incoming"
            ? edge.from
            : direction === "both" && edge.to === current.id
            ? edge.from
            : edge.to;
        if (visited.has(nextId)) continue;
        visited.add(nextId);
        const node = this.graph.nodes.get(nextId);
        if (node) result.push(node);
        queue.push({ id: nextId, depth: current.depth + 1 });
      }
    }

    return result;
  }

  async isReachable(
    from: AnchorId,
    to: AnchorId,
    options: TraversalOptions = {},
  ): Promise<boolean> {
    if (from === to) return true;
    const reachableNodes = await this.reachable(from, options);
    return reachableNodes.some((n) => n.id === to);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _neighborEdges(id: AnchorId, direction: "outgoing" | "incoming" | "both"): Edge[] {
    const out = direction === "outgoing" || direction === "both"
      ? this.graph.adjacency.get(id) ?? []
      : [];
    const inc = direction === "incoming" || direction === "both"
      ? this.graph.reverseAdjacency.get(id) ?? []
      : [];
    return [...out, ...inc];
  }
}
