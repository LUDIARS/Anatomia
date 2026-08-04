import type { KnowledgeEdge, KnowledgeEdgeKind, KnowledgeNode, KnowledgeGraph } from "./types.js";

export class KnowledgeProjection {
  private readonly outgoing = new Map<string, KnowledgeEdge[]>();
  private readonly incoming = new Map<string, KnowledgeEdge[]>();

  constructor(readonly head: string | null, readonly nodes: ReadonlyMap<string, KnowledgeNode>, edges: Iterable<KnowledgeEdge>) {
    for (const edge of edges) {
      // Push into the existing bucket: rebuilding it per edge made adjacency
      // construction quadratic in the fan-out of a single node.
      const from = this.outgoing.get(edge.from);
      if (from) from.push(edge); else this.outgoing.set(edge.from, [edge]);
      const to = this.incoming.get(edge.to);
      if (to) to.push(edge); else this.incoming.set(edge.to, [edge]);
    }
    for (const values of this.outgoing.values()) values.sort((a, b) => a.id.localeCompare(b.id));
    for (const values of this.incoming.values()) values.sort((a, b) => a.id.localeCompare(b.id));
  }

  static fromState(state: KnowledgeGraph): KnowledgeProjection {
    return new KnowledgeProjection(state.head, new Map(state.nodes), state.edges.values());
  }

  node(id: string): KnowledgeNode | undefined {
    return this.nodes.get(id);
  }

  edgesFrom(id: string, kind?: KnowledgeEdgeKind): KnowledgeEdge[] {
    return (this.outgoing.get(id) ?? []).filter((edge) => !kind || edge.kind === kind);
  }

  edgesTo(id: string, kind?: KnowledgeEdgeKind): KnowledgeEdge[] {
    return (this.incoming.get(id) ?? []).filter((edge) => !kind || edge.kind === kind);
  }

  ancestors(id: string, relation: "subdomain-of" | "subscene-of" = "subdomain-of"): KnowledgeNode[] {
    const result: KnowledgeNode[] = [];
    const seen = new Set<string>();
    let current = id;
    while (true) {
      const parent = this.edgesFrom(current, relation)[0]?.to;
      if (!parent || seen.has(parent)) break;
      seen.add(parent);
      const node = this.nodes.get(parent);
      if (node) result.push(node);
      current = parent;
    }
    return result;
  }

  descendants(id: string, relation: "subdomain-of" | "subscene-of" = "subdomain-of"): KnowledgeNode[] {
    const result: KnowledgeNode[] = [];
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const edge of this.edgesTo(parent, relation)) {
        if (seen.has(edge.from)) continue;
        seen.add(edge.from);
        queue.push(edge.from);
        const node = this.nodes.get(edge.from);
        if (node) result.push(node);
      }
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }

  scenesForDomain(domainId: string): KnowledgeNode[] {
    return this.edgesTo(domainId, "scene-activates-domain")
      .map((edge) => this.nodes.get(edge.from))
      .filter((node): node is KnowledgeNode => node?.kind === "scene");
  }

  scenesForSpec(specClauseId: string): KnowledgeNode[] {
    return this.edgesTo(specClauseId, "scene-relates-spec")
      .map((edge) => this.nodes.get(edge.from))
      .filter((node): node is KnowledgeNode => node?.kind === "scene");
  }
}
