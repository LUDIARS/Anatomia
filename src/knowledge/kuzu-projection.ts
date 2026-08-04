import { canonicalJson } from "./canonical-json.js";
import { KnowledgeProjection } from "./projection.js";
import type { KnowledgeGraph } from "./types.js";

interface KuzuResult { close(): void }
interface KuzuPreparedStatement { close?(): void }
interface KuzuConnection {
  query(cypher: string): Promise<KuzuResult>;
  prepare(cypher: string): Promise<KuzuPreparedStatement>;
  execute(statement: KuzuPreparedStatement, params: Record<string, unknown>): Promise<KuzuResult>;
  close(): void;
}
interface KuzuDatabase { close(): void }
interface KuzuModule {
  Database: new (path: string) => KuzuDatabase;
  Connection: new (db: KuzuDatabase) => KuzuConnection;
}

/** DDL only — no log-derived value is ever interpolated into a statement string. */
async function runDdl(connection: KuzuConnection, cypher: string): Promise<void> {
  const result = await connection.query(cypher);
  result.close();
}

/**
 * Ids, kinds and JSON payloads come straight from the knowledge log, so they are
 * bound as parameters instead of escaped into the Cypher text: a hand-rolled
 * quote/backslash escaper leaks injection the first time an id carries a
 * character it does not handle.
 */
async function runBound(
  connection: KuzuConnection,
  statement: KuzuPreparedStatement,
  params: Record<string, unknown>,
): Promise<void> {
  const result = await connection.execute(statement, params);
  result.close();
}

/** Read-only Kuzu materialization. The canonical log/state is the only constructor input. */
export class KuzuKnowledgeProjection {
  readonly query: KnowledgeProjection;

  private constructor(
    private readonly database: KuzuDatabase,
    private readonly connection: KuzuConnection,
    state: KnowledgeGraph,
  ) {
    this.query = KnowledgeProjection.fromState(state);
  }

  static async create(state: KnowledgeGraph, path = ":memory:"): Promise<KuzuKnowledgeProjection> {
    const kuzu = await import("kuzu") as unknown as KuzuModule;
    const database = new kuzu.Database(path);
    const connection = new kuzu.Connection(database);
    await runDdl(connection, "CREATE NODE TABLE KnowledgeNode(id STRING, kind STRING, data STRING, PRIMARY KEY(id))");
    await runDdl(connection, "CREATE REL TABLE KnowledgeEdge(FROM KnowledgeNode TO KnowledgeNode, id STRING, kind STRING, evidence STRING)");

    const insertNode = await connection.prepare(
      "CREATE (:KnowledgeNode {id: $id, kind: $kind, data: $data})");
    for (const node of [...state.nodes.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      await runBound(connection, insertNode, {
        id: node.id,
        kind: node.kind,
        data: canonicalJson(node),
      });
    }

    const insertEdge = await connection.prepare(
      "MATCH (a:KnowledgeNode), (b:KnowledgeNode) WHERE a.id = $from AND b.id = $to "
      + "CREATE (a)-[:KnowledgeEdge {id: $id, kind: $kind, evidence: $evidence}]->(b)");
    for (const edge of [...state.edges.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      await runBound(connection, insertEdge, {
        from: edge.from,
        to: edge.to,
        id: edge.id,
        kind: edge.kind,
        evidence: canonicalJson(edge.evidence ?? {}),
      });
    }
    return new KuzuKnowledgeProjection(database, connection, state);
  }

  close(): void {
    this.connection.close();
    this.database.close();
  }
}
