/**
 * T13 — Kuzu KG projection: CodeGraphQuery backed by Kuzu.
 *
 * The in-memory CodeGraph (T11) is the source of truth; Kuzu is a
 * materialized view that can be regenerated at any time.
 *
 * Schema
 * ------
 *   NODE TABLE CodeUnit (
 *     id      STRING,   -- AnchorId
 *     name    STRING,
 *     kind    STRING,   -- CodeNode.kind
 *     file    STRING,   -- sourceRange.filePath
 *     sline   INT64,    -- sourceRange.start.line
 *     eline   INT64,    -- sourceRange.end.line
 *     PRIMARY KEY (id)
 *   )
 *
 *   NODE TABLE SpecClause (
 *     id      STRING,
 *     source  STRING,
 *     heading STRING,
 *     text    STRING,
 *     PRIMARY KEY (id)
 *   )
 *
 *   REL TABLE CALLS    (FROM CodeUnit TO CodeUnit)
 *   REL TABLE DEPENDS  (FROM CodeUnit TO CodeUnit)
 *   REL TABLE READS    (FROM CodeUnit TO CodeUnit)
 *   REL TABLE WRITES   (FROM CodeUnit TO CodeUnit)
 *   REL TABLE IMPLEMENTS (FROM CodeUnit TO SpecClause)
 *
 * Usage pattern
 * -------------
 *   const kq = await KuzuCodeGraph.create(graph);   // project in-mem → Kuzu
 *   const callers = await kq.predecessors(id, 'calls');
 *   // When done (in tests / process exit), call kq.close() — or just let
 *   // the process exit (kuzu 0.11 segfaults on explicit .close() in some
 *   // environments; process.exit() is safe).
 *
 * Note on kuzu 0.11 (installed version)
 * ---------------------------------------
 *   - `conn.close()` / `db.close()` may segfault on Windows; prefer
 *     `process.exit()` in scripts.  In tests we call `close()` guarded
 *     in a try/catch so the rest of the test run is unaffected.
 *   - Kuzu 0.11 is deprecated on npm; a newer version should be adopted when
 *     the project upgrades Node / npm.  The interface is unchanged.
 */

import type { AnchorId, CodeNode, Edge, EdgeKind, SpecClause } from "../types.js";
import type { CodeGraph } from "./build.js";
import type {
  CodeGraphQuery,
  EdgeFilter,
  FanCounts,
  TraversalOptions,
} from "./query.js";

// ---------------------------------------------------------------------------
// Lazy kuzu import so the module can be loaded even if kuzu is absent
// ---------------------------------------------------------------------------

interface KuzuModule {
  Database: new (path: string) => KuzuDatabase;
  Connection: new (db: KuzuDatabase) => KuzuConnection;
}

interface KuzuDatabase {
  close(): void;
}

interface KuzuConnection {
  query(cypher: string): Promise<KuzuResult>;
  close(): void;
}

interface KuzuResult {
  getAll(): Promise<Record<string, unknown>[]>;
  hasNext(): Promise<boolean>;
  getNext(): Promise<Record<string, unknown>>;
  close(): void;
}

async function loadKuzu(): Promise<KuzuModule> {
  try {
    return (await import("kuzu")) as unknown as KuzuModule;
  } catch (err) {
    throw new Error(
      `kuzu is not available: ${(err as Error).message}. ` +
        "Install it with: npm install kuzu",
    );
  }
}

// ---------------------------------------------------------------------------
// Edge-kind → Kuzu rel-table mapping
// ---------------------------------------------------------------------------

const KIND_TO_TABLE: Record<string, string> = {
  calls: "CALLS",
  depends: "DEPENDS",
  reads: "READS",
  writes: "WRITES",
  implements: "IMPLEMENTS",
  overrides: "OVERRIDES",
  includes: "INCLUDES",
};

// Only the edge kinds we actually project between CodeUnit nodes.
const CODE_UNIT_EDGE_KINDS: EdgeKind[] = ["calls", "depends", "reads", "writes"];

// ---------------------------------------------------------------------------
// KuzuCodeGraph
// ---------------------------------------------------------------------------

export class KuzuCodeGraph implements CodeGraphQuery {
  private readonly conn: KuzuConnection;
  private readonly db: KuzuDatabase;
  // Shadow in-memory index for node lookups (avoids a Kuzu round-trip per node).
  private readonly nodeIndex: Map<AnchorId, CodeNode>;

  private constructor(
    db: KuzuDatabase,
    conn: KuzuConnection,
    nodeIndex: Map<AnchorId, CodeNode>,
  ) {
    this.db = db;
    this.conn = conn;
    this.nodeIndex = nodeIndex;
  }

  /**
   * Project an in-memory CodeGraph into a fresh Kuzu in-memory database and
   * return a KuzuCodeGraph backed by it.
   *
   * @param graph   The in-memory graph (output of buildGraph in build.ts).
   * @param specClauses  Optional SpecClause nodes to also project.
   */
  static async create(
    graph: CodeGraph,
    specClauses: SpecClause[] = [],
  ): Promise<KuzuCodeGraph> {
    const kuzu = await loadKuzu();
    const db = new kuzu.Database(":memory:");
    const conn = new kuzu.Connection(db);

    await KuzuCodeGraph._createSchema(conn);
    await KuzuCodeGraph._projectNodes(conn, graph, specClauses);
    await KuzuCodeGraph._projectEdges(conn, graph);

    const nodeIndex = new Map<AnchorId, CodeNode>(graph.nodes);
    return new KuzuCodeGraph(db, conn, nodeIndex);
  }

  // ── Schema creation ───────────────────────────────────────────────────────

  private static async _createSchema(conn: KuzuConnection): Promise<void> {
    await conn.query(
      "CREATE NODE TABLE CodeUnit(" +
        "id STRING, name STRING, kind STRING, file STRING, sline INT64, eline INT64, " +
        "PRIMARY KEY(id)" +
        ")",
    );
    await conn.query(
      "CREATE NODE TABLE SpecClause(" +
        "id STRING, source STRING, heading STRING, txt STRING, " +
        "PRIMARY KEY(id)" +
        ")",
    );
    // Edge tables for CodeUnit → CodeUnit
    for (const kind of CODE_UNIT_EDGE_KINDS) {
      const table = KIND_TO_TABLE[kind]!;
      await conn.query(
        `CREATE REL TABLE ${table}(FROM CodeUnit TO CodeUnit)`,
      );
    }
    // Edge table for CodeUnit → SpecClause (placeholder for G4)
    await conn.query("CREATE REL TABLE IMPLEMENTS(FROM CodeUnit TO SpecClause)");
  }

  // ── Node projection ───────────────────────────────────────────────────────

  private static async _projectNodes(
    conn: KuzuConnection,
    graph: CodeGraph,
    specClauses: SpecClause[],
  ): Promise<void> {
    for (const node of graph.nodes.values()) {
      const file = node.sourceRange.filePath.replace(/\\/g, "/").replace(/'/g, "\\'");
      const name = node.name.replace(/'/g, "\\'");
      const sline = node.sourceRange.start.line;
      const eline = node.sourceRange.end.line;
      await conn.query(
        `CREATE (:CodeUnit {` +
          `id: '${node.id}', ` +
          `name: '${name}', ` +
          `kind: '${node.kind}', ` +
          `file: '${file}', ` +
          `sline: ${sline}, ` +
          `eline: ${eline}` +
          `})`,
      );
    }

    for (const sc of specClauses) {
      const id = sc.id.replace(/'/g, "\\'");
      const source = sc.sourceFile.replace(/'/g, "\\'");
      const heading = sc.heading.replace(/'/g, "\\'");
      const txt = sc.text.replace(/'/g, "\\'").replace(/\n/g, " ");
      await conn.query(
        `CREATE (:SpecClause {` +
          `id: '${id}', ` +
          `source: '${source}', ` +
          `heading: '${heading}', ` +
          `txt: '${txt}'` +
          `})`,
      );
    }
  }

  // ── Edge projection ───────────────────────────────────────────────────────

  private static async _projectEdges(conn: KuzuConnection, graph: CodeGraph): Promise<void> {
    for (const edge of graph.edges) {
      const table = KIND_TO_TABLE[edge.kind];
      if (!table) continue; // skip non-CodeUnit edge kinds (implements etc.)
      if (!CODE_UNIT_EDGE_KINDS.includes(edge.kind as EdgeKind)) continue;
      await conn.query(
        `MATCH (a:CodeUnit), (b:CodeUnit) ` +
          `WHERE a.id = '${edge.from}' AND b.id = '${edge.to}' ` +
          `CREATE (a)-[:${table}]->(b)`,
      );
    }
  }

  // ── Node lookups ─────────────────────────────────────────────────────────

  async getNode(id: AnchorId): Promise<CodeNode | undefined> {
    return this.nodeIndex.get(id);
  }

  async allNodes(): Promise<CodeNode[]> {
    return Array.from(this.nodeIndex.values());
  }

  // ── Neighbour queries ────────────────────────────────────────────────────

  async neighbors(id: AnchorId, kind?: EdgeKind): Promise<CodeNode[]> {
    return this._queryNeighbors(id, kind, "outgoing");
  }

  async predecessors(id: AnchorId, kind?: EdgeKind): Promise<CodeNode[]> {
    return this._queryNeighbors(id, kind, "incoming");
  }

  private async _queryNeighbors(
    id: AnchorId,
    kind: EdgeKind | undefined,
    direction: "outgoing" | "incoming",
  ): Promise<CodeNode[]> {
    const kinds = kind ? [kind] : CODE_UNIT_EDGE_KINDS;
    const results: CodeNode[] = [];
    const seen = new Set<AnchorId>();

    for (const k of kinds) {
      const table = KIND_TO_TABLE[k];
      if (!table) continue;
      let cypher: string;
      if (direction === "outgoing") {
        cypher =
          `MATCH (a:CodeUnit)-[:${table}]->(b:CodeUnit) ` +
          `WHERE a.id = '${id}' RETURN b.id AS nid`;
      } else {
        cypher =
          `MATCH (a:CodeUnit)<-[:${table}]-(b:CodeUnit) ` +
          `WHERE a.id = '${id}' RETURN b.id AS nid`;
      }
      const rows = await this._runAll(cypher);
      for (const row of rows) {
        const nid = row["nid"] as AnchorId;
        if (seen.has(nid)) continue;
        seen.add(nid);
        const node = this.nodeIndex.get(nid);
        if (node) results.push(node);
      }
    }
    return results;
  }

  // ── Edge queries ─────────────────────────────────────────────────────────

  async edgesFrom(id: AnchorId, kind?: EdgeKind): Promise<Edge[]> {
    return this._queryEdges(id, kind, "outgoing");
  }

  async edgesTo(id: AnchorId, kind?: EdgeKind): Promise<Edge[]> {
    return this._queryEdges(id, kind, "incoming");
  }

  private async _queryEdges(
    id: AnchorId,
    kind: EdgeKind | undefined,
    direction: "outgoing" | "incoming",
  ): Promise<Edge[]> {
    const kinds = kind ? [kind] : CODE_UNIT_EDGE_KINDS;
    const edges: Edge[] = [];

    for (const k of kinds) {
      const table = KIND_TO_TABLE[k];
      if (!table) continue;
      let cypher: string;
      if (direction === "outgoing") {
        cypher =
          `MATCH (a:CodeUnit)-[:${table}]->(b:CodeUnit) ` +
          `WHERE a.id = '${id}' RETURN a.id AS fromId, b.id AS toId`;
      } else {
        cypher =
          `MATCH (a:CodeUnit)<-[:${table}]-(b:CodeUnit) ` +
          `WHERE a.id = '${id}' RETURN b.id AS fromId, a.id AS toId`;
      }
      const rows = await this._runAll(cypher);
      for (const row of rows) {
        edges.push({
          from: row["fromId"] as AnchorId,
          to: row["toId"] as AnchorId,
          kind: k,
        });
      }
    }
    return edges;
  }

  async edgesMatching(filter: EdgeFilter): Promise<Edge[]> {
    const kinds = filter.kind ? [filter.kind] : CODE_UNIT_EDGE_KINDS;
    const edges: Edge[] = [];

    for (const k of kinds) {
      const table = KIND_TO_TABLE[k];
      if (!table) continue;

      const conditions: string[] = [];
      if (filter.fromName) {
        conditions.push(`a.name = '${filter.fromName.replace(/'/g, "\\'")}'`);
      }
      if (filter.toName) {
        conditions.push(`b.name = '${filter.toName.replace(/'/g, "\\'")}'`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const cypher =
        `MATCH (a:CodeUnit)-[:${table}]->(b:CodeUnit) ${where} ` +
        `RETURN a.id AS fromId, b.id AS toId`;

      const rows = await this._runAll(cypher);
      for (const row of rows) {
        edges.push({
          from: row["fromId"] as AnchorId,
          to: row["toId"] as AnchorId,
          kind: k,
        });
      }
    }
    return edges;
  }

  // ── Aggregates ───────────────────────────────────────────────────────────

  async fanCounts(id: AnchorId, kind?: EdgeKind): Promise<FanCounts> {
    const kinds = kind ? [kind] : CODE_UNIT_EDGE_KINDS;
    let fanOut = 0;
    let fanIn = 0;

    for (const k of kinds) {
      const table = KIND_TO_TABLE[k];
      if (!table) continue;

      const outRow = await this._runAll(
        `MATCH (a:CodeUnit)-[:${table}]->(b:CodeUnit) WHERE a.id = '${id}' RETURN count(b) AS cnt`,
      );
      fanOut += Number((outRow[0]?.["cnt"] as number | undefined) ?? 0);

      const inRow = await this._runAll(
        `MATCH (a:CodeUnit)<-[:${table}]-(b:CodeUnit) WHERE a.id = '${id}' RETURN count(b) AS cnt`,
      );
      fanIn += Number((inRow[0]?.["cnt"] as number | undefined) ?? 0);
    }

    return { fanIn, fanOut };
  }

  // ── Reachability / traversal ──────────────────────────────────────────────

  /**
   * BFS traversal using Kuzu — falls back to iterative single-hop queries
   * because kuzu 0.11 does not support variable-length path queries reliably.
   */
  async reachable(id: AnchorId, options: TraversalOptions = {}): Promise<CodeNode[]> {
    const { maxDepth = Infinity, kinds, direction = "outgoing" } = options;
    const activeKinds = kinds ?? CODE_UNIT_EDGE_KINDS;

    const visited = new Set<AnchorId>([id]);
    const result: CodeNode[] = [];
    let frontier: AnchorId[] = [id];
    let depth = 0;

    while (frontier.length > 0 && depth < maxDepth) {
      const next: AnchorId[] = [];
      for (const fid of frontier) {
        const nodes =
          direction === "incoming"
            ? await this._queryNeighbors(fid, undefined, "incoming")
            : direction === "both"
            ? [
                ...(await this._queryNeighbors(fid, undefined, "outgoing")),
                ...(await this._queryNeighbors(fid, undefined, "incoming")),
              ]
            : await this._queryNeighbors(fid, undefined, "outgoing");

        const filtered = activeKinds
          ? await Promise.all(
              activeKinds.map((k) =>
                direction === "incoming"
                  ? this._queryNeighbors(fid, k, "incoming")
                  : this._queryNeighbors(fid, k, "outgoing"),
              ),
            ).then((arrs) => arrs.flat())
          : nodes;

        const deduped = filtered.filter((n) => !visited.has(n.id));
        for (const n of deduped) {
          visited.add(n.id);
          result.push(n);
          next.push(n.id);
        }
      }
      frontier = next;
      depth++;
    }

    return result;
  }

  async isReachable(
    from: AnchorId,
    to: AnchorId,
    options: TraversalOptions = {},
  ): Promise<boolean> {
    if (from === to) return true;
    const nodes = await this.reachable(from, options);
    return nodes.some((n) => n.id === to);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Release Kuzu resources.
   *
   * Kuzu 0.11 may segfault on explicit close() on some platforms.
   * Wrap in try/catch and allow process exit to clean up if necessary.
   */
  close(): void {
    try {
      this.conn.close();
    } catch (_) {
      /* ignore */
    }
    try {
      this.db.close();
    } catch (_) {
      /* ignore */
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async _runAll(cypher: string): Promise<Record<string, unknown>[]> {
    const result = await this.conn.query(cypher);
    return result.getAll();
  }
}
