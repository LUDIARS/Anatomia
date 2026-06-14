/**
 * T12 — CodeGraphQuery interface (query-layer abstraction).
 *
 * Defines the seam between consumers of graph queries and the underlying
 * storage (in-memory or Kuzu). Any storage backend implements this interface;
 * consumers depend only on it, not on the concrete implementation.
 *
 * Responsibilities:
 *   - Neighbour enumeration (outgoing / incoming, optionally filtered by kind)
 *   - Reachability traversal (BFS/DFS, depth-limited)
 *   - Fan-in / fan-out aggregates
 *   - Predicate-style "edges matching (fromKind?, toKind?, edgeKind?)" queries
 *
 * This file contains only the interface and supporting types.
 * Implementations live in in-memory.ts (T12) and kuzu.ts (T13).
 */

import type { AnchorId, CodeNode, Edge, EdgeKind } from "../types.js";

// ---------------------------------------------------------------------------
// Predicate filter type
// ---------------------------------------------------------------------------

/** Filter for edges.  All fields are optional and ANDed together. */
export interface EdgeFilter {
  /** If set, only edges whose `from` node has this name (CodeNode.name). */
  fromName?: string;
  /** If set, only edges whose `to` node has this name. */
  toName?: string;
  /** If set, only edges of this kind. */
  kind?: EdgeKind;
}

// ---------------------------------------------------------------------------
// Traversal options
// ---------------------------------------------------------------------------

export interface TraversalOptions {
  /** Maximum traversal depth (1 = direct neighbours only). Default: Infinity. */
  maxDepth?: number;
  /** Which edge kinds to follow. Default: all kinds. */
  kinds?: EdgeKind[];
  /** Direction: follow outgoing edges ('outgoing'), incoming ('incoming'), or both. Default: 'outgoing'. */
  direction?: "outgoing" | "incoming" | "both";
}

// ---------------------------------------------------------------------------
// Query result types
// ---------------------------------------------------------------------------

export interface FanCounts {
  /** Number of edges pointing IN to the node (callers / writers). */
  fanIn: number;
  /** Number of edges pointing OUT from the node (callees / reads). */
  fanOut: number;
}

// ---------------------------------------------------------------------------
// CodeGraphQuery interface
// ---------------------------------------------------------------------------

/**
 * Abstract interface over an in-memory or persisted code graph.
 *
 * All methods are synchronous on the in-memory implementation; the async
 * signature is chosen so that the Kuzu implementation (which is inherently
 * async) can satisfy the same interface without overloads.
 */
export interface CodeGraphQuery {
  // ── Node lookups ──────────────────────────────────────────────────────────

  /** Retrieve a node by its AnchorId. Returns undefined if not found. */
  getNode(id: AnchorId): Promise<CodeNode | undefined>;

  /** Return all nodes in the graph. */
  allNodes(): Promise<CodeNode[]>;

  // ── Neighbour queries ────────────────────────────────────────────────────

  /**
   * Outgoing neighbours of `id` — i.e. nodes that `id` calls / reads / writes.
   * Optionally filtered to a specific edge kind.
   */
  neighbors(id: AnchorId, kind?: EdgeKind): Promise<CodeNode[]>;

  /**
   * Incoming neighbours of `id` — i.e. nodes that call / read / write `id`.
   * Optionally filtered to a specific edge kind.
   */
  predecessors(id: AnchorId, kind?: EdgeKind): Promise<CodeNode[]>;

  // ── Edge queries ─────────────────────────────────────────────────────────

  /** Return all edges from `id` (optionally filtered by kind). */
  edgesFrom(id: AnchorId, kind?: EdgeKind): Promise<Edge[]>;

  /** Return all edges to `id` (optionally filtered by kind). */
  edgesTo(id: AnchorId, kind?: EdgeKind): Promise<Edge[]>;

  /**
   * Predicate-style edge query.
   * Returns all edges matching ALL supplied filter fields.
   */
  edgesMatching(filter: EdgeFilter): Promise<Edge[]>;

  // ── Aggregates ───────────────────────────────────────────────────────────

  /**
   * Fan-in and fan-out counts for a node.
   * Optionally restricted to a specific edge kind.
   */
  fanCounts(id: AnchorId, kind?: EdgeKind): Promise<FanCounts>;

  // ── Reachability / traversal ──────────────────────────────────────────────

  /**
   * BFS traversal starting at `id`.
   * Returns all reachable nodes (excluding the start node itself).
   * Options control direction, depth limit, and which edge kinds are followed.
   */
  reachable(id: AnchorId, options?: TraversalOptions): Promise<CodeNode[]>;

  /**
   * Check whether `to` is reachable from `from` (following outgoing edges).
   */
  isReachable(from: AnchorId, to: AnchorId, options?: TraversalOptions): Promise<boolean>;
}
