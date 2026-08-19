import { createHash } from "node:crypto";
import { relative } from "node:path";
import type { AnalysisContext } from "../../core.js";
import type { AnchorId, CodeNode, Link, SpecClause } from "../../types.js";
import { reachClosure } from "../../graph/traverse.js";
import { canonicalJson } from "../canonical-json.js";
import { describeCodeSymbol, type AnalyzedCodeSymbolEvidence } from "../code-symbol.js";
import { sceneElementEntityId } from "../identity.js";
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from "../types.js";
import type {
  CanonicalScene,
  CanonicalSceneElement,
  CanonicalSceneGraph,
  SceneDefinitionSeed,
} from "./types.js";

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function edge(
  owner: string,
  kind: KnowledgeEdge["kind"],
  from: string,
  to: string,
  evidence: Record<string, unknown> = {},
): KnowledgeEdge {
  return {
    id: `${kind}:${from}->${to}`,
    kind,
    from,
    to,
    evidence: { ...evidence, derivedOwner: owner },
  };
}

function domainIdsFor(state: KnowledgeGraph, codeSymbolIds: Set<string>): string[] {
  return [...new Set([...state.edges.values()]
    .filter((candidate) => candidate.kind === "domain-owns-code" && codeSymbolIds.has(candidate.to))
    .map((candidate) => candidate.from))].sort();
}

function clauseIdsFor(state: KnowledgeGraph, codeSymbolIds: Set<string>): string[] {
  return [...new Set([...state.edges.values()]
    .filter((candidate) => candidate.kind === "code-relates-spec" && codeSymbolIds.has(candidate.from))
    .map((candidate) => candidate.to))].sort();
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function authoritativeSpecLinks(
  ctx: AnalysisContext,
  node: CodeNode,
  clausesById: ReadonlyMap<string, SpecClause>,
): Link[] {
  const anchorId = String(node.id);
  const absolutePath = normalizedPath(node.sourceRange.filePath);
  const relativePath = normalizedPath(relative(ctx.repoPath, node.sourceRange.filePath));
  return (ctx.links ?? []).filter((link) => {
    if (link.evidence !== "explicit" && link.ratified !== true) return false;
    if (!clausesById.has(link.to)) return false;
    const from = normalizedPath(String(link.from));
    return from === anchorId || from === absolutePath || from === relativePath;
  });
}

function knowledgeSpecNode(owner: string, clause: SpecClause): KnowledgeNode {
  const revision = clause.provenance?.sourceRevision
    ?? clause.revisionHash
    ?? fingerprint({ sourceFile: clause.sourceFile, heading: clause.heading, text: clause.text });
  return {
    id: clause.id,
    kind: "spec-clause",
    revision: {
      sourceRevision: revision,
      contentFingerprint: clause.revisionHash ?? fingerprint(clause),
      sourcePath: clause.sourceFile,
      ...(clause.sourceLines ? { sourceRange: { startLine: clause.sourceLines.start, endLine: clause.sourceLines.end } } : {}),
    },
    data: {
      documentId: clause.documentId,
      heading: clause.heading,
      derivedOwner: owner,
    },
  };
}

function definitionIndex(definitions: SceneDefinitionSeed[]): Map<string, SceneDefinitionSeed[]> {
  const index = new Map<string, SceneDefinitionSeed[]>();
  for (const definition of definitions) {
    for (const reference of new Set([definition.sceneId, ...definition.referenceKeys])) {
      index.set(reference, [...(index.get(reference) ?? []), definition]);
    }
  }
  return index;
}

function sharedDirectoryDepth(left: string, right: string): number {
  const leftParts = left.replace(/\\/g, "/").split("/").slice(0, -1);
  const rightParts = right.replace(/\\/g, "/").split("/").slice(0, -1);
  let depth = 0;
  while (depth < leftParts.length && depth < rightParts.length && leftParts[depth] === rightParts[depth]) depth += 1;
  return depth;
}

/**
 * Same-named candidates are disambiguated by source proximity: the candidate
 * declared closest to the referring scene (deepest shared directory) wins when
 * that closeness is unique. Equidistant candidates stay ambiguous — never chosen
 * by sort order — because a wrong composition edge is worse than none.
 */
function nearestByDirectory(referrerPath: string, active: SceneDefinitionSeed[]): SceneDefinitionSeed | undefined {
  const ranked = active
    .map((candidate) => ({ candidate, depth: sharedDirectoryDepth(referrerPath, candidate.sourceAnchor.path) }))
    .sort((left, right) => right.depth - left.depth);
  return ranked[0] && (!ranked[1] || ranked[0].depth > ranked[1].depth) ? ranked[0].candidate : undefined;
}

function resolveDefinitionReference(
  reference: string,
  index: ReadonlyMap<string, SceneDefinitionSeed[]>,
  referrer?: SceneDefinitionSeed,
): SceneDefinitionSeed | undefined {
  const candidates = index.get(reference) ?? [];
  const exact = candidates.find((candidate) => candidate.sceneId === reference);
  if (exact) return exact;
  const active = candidates.filter((candidate) => !candidate.tombstone);
  if (active.length > 1) {
    const nearest = referrer ? nearestByDirectory(referrer.sourceAnchor.path, active) : undefined;
    if (nearest) return nearest;
    const sources = active.map((candidate) => candidate.sourceAnchor.path).sort().join(", ");
    throw new Error(`ambiguous scene reference "${reference}" matches: ${sources}`);
  }
  return active[0];
}

function validateUniqueSceneIds(definitions: SceneDefinitionSeed[]): void {
  const sceneIds = new Set<string>();
  for (const definition of definitions) {
    if (sceneIds.has(definition.sceneId)) {
      throw new Error(`duplicate canonical scene identity: ${definition.sceneId}`);
    }
    sceneIds.add(definition.sceneId);
  }
}

function codeSpecRelationIndex(state: KnowledgeGraph): Map<string, KnowledgeEdge> {
  const relations = new Map<string, KnowledgeEdge>();
  for (const candidate of state.edges.values()) {
    if (candidate.kind === "code-relates-spec") {
      relations.set(`${candidate.from}\0${candidate.to}`, candidate);
    }
  }
  return relations;
}

function knowledgeCodeNode(owner: string, symbol: AnalyzedCodeSymbolEvidence): KnowledgeNode {
  return {
    id: symbol.symbolId,
    kind: "code-symbol",
    revision: {
      sourceRevision: symbol.sourceRevision,
      contentFingerprint: symbol.contentFingerprint,
      sourcePath: symbol.sourcePath,
      sourceRange: { startLine: symbol.startLine, endLine: symbol.endLine },
    },
    data: {
      language: symbol.language,
      qualifiedName: symbol.qualifiedName,
      signature: symbol.signature,
      signatureShape: symbol.signatureShape,
      derivedOwner: owner,
    },
  };
}

interface ReachedCodeSymbol {
  node: CodeNode;
  symbol: AnalyzedCodeSymbolEvidence;
}

function deriveCodeSpecRelations(input: {
  owner: string;
  context: AnalysisContext;
  reached: ReachedCodeSymbol[];
  clausesById: ReadonlyMap<string, SpecClause>;
  knowledgeState: KnowledgeGraph;
  existingRelations: ReadonlyMap<string, KnowledgeEdge>;
}): { nodes: KnowledgeNode[]; edges: KnowledgeEdge[]; clauseIds: string[] } {
  const nodes: KnowledgeNode[] = [];
  const edges: KnowledgeEdge[] = [];
  const clauseIds = new Set<string>();
  for (const { node, symbol } of input.reached) {
    for (const link of authoritativeSpecLinks(input.context, node, input.clausesById)) {
      const clause = input.clausesById.get(link.to)!;
      const existing = input.knowledgeState.nodes.get(clause.id);
      if (existing && existing.kind !== "spec-clause") {
        throw new Error(`spec link target ${clause.id} is not a spec-clause node`);
      }
      if (!existing || existing.data?.derivedOwner === input.owner) {
        nodes.push(knowledgeSpecNode(input.owner, clause));
      }
      const existingRelation = input.existingRelations.get(`${symbol.symbolId}\0${clause.id}`);
      if (!existingRelation || existingRelation.evidence?.derivedOwner === input.owner) {
        edges.push(edge(input.owner, "code-relates-spec", symbol.symbolId, clause.id, {
          linkEvidence: link.evidence,
          confidence: link.confidence,
          ratified: link.ratified ?? false,
        }));
      }
      clauseIds.add(clause.id);
    }
  }
  return { nodes, edges, clauseIds: [...clauseIds].sort() };
}

function singleParentSubsceneEdges(
  owner: string,
  containmentParents: ReadonlyMap<string, ReadonlySet<string>>,
): KnowledgeEdge[] {
  const edges: KnowledgeEdge[] = [];
  for (const [childId, parents] of containmentParents) {
    if (parents.size === 1) edges.push(edge(owner, "subscene-of", childId, [...parents][0]!));
  }
  return edges;
}

export async function deriveCanonicalSceneGraph(input: {
  projectId: string;
  sourceRevision: string;
  context: AnalysisContext;
  definitions: SceneDefinitionSeed[];
  knowledgeState: KnowledgeGraph;
}): Promise<CanonicalSceneGraph> {
  const owner = `scene-definition:${input.projectId}`;
  validateUniqueSceneIds(input.definitions);
  const functionsByAnchor = new Map<string, CodeNode>();
  for (const node of await input.context.graph.allNodes()) if (node.id) functionsByAnchor.set(String(node.id), node);
  const definitionsByRef = definitionIndex(input.definitions);
  const clausesById = new Map((input.context.specClauses ?? []).map((clause) => [clause.id, clause]));
  const existingCodeSpecRelations = codeSpecRelationIndex(input.knowledgeState);

  const nodes: KnowledgeNode[] = [];
  const edges: KnowledgeEdge[] = [];
  const scenes: CanonicalScene[] = [];
  const containmentParents = new Map<string, Set<string>>();
  for (const definition of [...input.definitions].sort((left, right) => left.sceneId.localeCompare(right.sceneId))) {
    const entryAnchors = definition.entryAnchorIds
      .filter((anchor): anchor is AnchorId => functionsByAnchor.has(anchor));
    const reachedAnchors = definition.tombstone
      ? new Set<AnchorId>()
      : await reachClosure(input.context.graph, entryAnchors);
    const reached = [...reachedAnchors]
      .map((anchor) => {
        const node = functionsByAnchor.get(String(anchor))!;
        return {
          node,
          symbol: describeCodeSymbol(
            input.projectId,
            input.context.repoPath,
            node,
            input.sourceRevision,
          ),
        };
      })
      .sort((left, right) => left.symbol.symbolId.localeCompare(right.symbol.symbolId));
    const symbols = reached.map((item) => item.symbol);
    const entrySymbols = new Set(entryAnchors.map((anchor) => describeCodeSymbol(
      input.projectId,
      input.context.repoPath,
      functionsByAnchor.get(String(anchor))!,
      input.sourceRevision,
    ).symbolId));
    const reachedSymbolIds = new Set(symbols.map((symbol) => symbol.symbolId));
    const contained = definition.containsRefs
      .map((reference) => resolveDefinitionReference(reference, definitionsByRef, definition)?.sceneId)
      .filter((sceneId): sceneId is string => Boolean(sceneId) && sceneId !== definition.sceneId);
    const transitions = definition.transitionRefs
      .map((reference) => resolveDefinitionReference(reference, definitionsByRef, definition)?.sceneId)
      .filter((sceneId): sceneId is string => Boolean(sceneId) && sceneId !== definition.sceneId);
    const elements: CanonicalSceneElement[] = [...new Set(contained)].sort().map((childSceneId) => {
      const child = input.definitions.find((candidate) => candidate.sceneId === childSceneId)!;
      const realizedSymbols = child.entryAnchorIds
        .map((anchor) => functionsByAnchor.get(anchor))
        .filter((node): node is CodeNode => Boolean(node?.id))
        .map((node) => describeCodeSymbol(input.projectId, input.context.repoPath, node, input.sourceRevision));
      for (const symbol of realizedSymbols) {
        const existing = input.knowledgeState.nodes.get(symbol.symbolId);
        if (!existing || existing.data?.derivedOwner === owner) nodes.push(knowledgeCodeNode(owner, symbol));
      }
      return {
        id: sceneElementEntityId(input.projectId, definition.sceneId, childSceneId),
        label: child.label,
        sourceAnchor: child.sourceAnchor,
        realizedByCodeSymbolIds: realizedSymbols.map((symbol) => symbol.symbolId).sort(),
      };
    });
    const activeDomainIds = domainIdsFor(input.knowledgeState, reachedSymbolIds);
    const relatedSpecClauseIds = new Set(clauseIdsFor(input.knowledgeState, reachedSymbolIds));
    const specRelations = deriveCodeSpecRelations({
      owner,
      context: input.context,
      reached,
      clausesById,
      knowledgeState: input.knowledgeState,
      existingRelations: existingCodeSpecRelations,
    });
    nodes.push(...specRelations.nodes);
    edges.push(...specRelations.edges);
    for (const clauseId of specRelations.clauseIds) relatedSpecClauseIds.add(clauseId);
    const scene: CanonicalScene = {
      id: definition.sceneId,
      nativeIdentity: definition.nativeIdentity,
      referenceKeys: [...definition.referenceKeys].sort(),
      label: definition.label,
      kind: definition.kind,
      origin: definition.origin,
      sourceRevision: definition.sourceRevision,
      identityBasis: definition.identityBasis,
      sourceAnchor: definition.sourceAnchor,
      aliases: [...definition.aliases].sort(),
      tombstone: definition.tombstone,
      entryCodeSymbolIds: [...entrySymbols].sort(),
      reachedCodeSymbolIds: [...reachedSymbolIds].sort(),
      activeDomainIds,
      relatedSpecClauseIds: [...relatedSpecClauseIds].sort(),
      containedSceneIds: [...new Set(contained)].sort(),
      transitionSceneIds: [...new Set(transitions)].sort(),
      elements,
    };
    scenes.push(scene);
    nodes.push({
      id: scene.id,
      kind: "scene",
      aliases: scene.aliases,
      revision: { sourceRevision: scene.sourceRevision, contentFingerprint: fingerprint(scene), sourcePath: scene.sourceAnchor.path },
      data: { ...scene, derivedOwner: owner },
    });
    for (const symbol of symbols) {
      const existing = input.knowledgeState.nodes.get(symbol.symbolId);
      if (!existing || existing.data?.derivedOwner === owner) {
        nodes.push(knowledgeCodeNode(owner, symbol));
      }
      edges.push(edge(owner, "scene-activates-code", scene.id, symbol.symbolId, {
        reachability: entrySymbols.has(symbol.symbolId) ? "direct" : "reached",
        sourceAnchor: `${symbol.sourcePath}:${symbol.startLine}`,
      }));
      if (entrySymbols.has(symbol.symbolId)) edges.push(edge(owner, "scene-has-entry", scene.id, symbol.symbolId));
    }
    for (const domainId of activeDomainIds) edges.push(edge(owner, "scene-activates-domain", scene.id, domainId, { derivedFrom: "domain-owns-code" }));
    for (const clauseId of scene.relatedSpecClauseIds) edges.push(edge(owner, "scene-relates-spec", scene.id, clauseId, { derivedFrom: "reached-code-spec-link" }));
    for (const transitionId of scene.transitionSceneIds) edges.push(edge(owner, "scene-transitions-to", scene.id, transitionId));
    for (const childId of scene.containedSceneIds) {
      const parents = containmentParents.get(childId) ?? new Set<string>();
      parents.add(scene.id);
      containmentParents.set(childId, parents);
    }
    for (const element of elements) {
      nodes.push({
        id: element.id,
        kind: "scene-element",
        revision: { sourceRevision: input.sourceRevision, contentFingerprint: fingerprint(element), sourcePath: element.sourceAnchor.path },
        data: { label: element.label, sourceAnchor: element.sourceAnchor, derivedOwner: owner },
      });
      edges.push(edge(owner, "scene-contains", scene.id, element.id));
      for (const symbolId of element.realizedByCodeSymbolIds) {
        edges.push(edge(owner, "scene-element-realized-by", element.id, symbolId));
      }
    }
  }

  // Reused components remain exact scene-contains relations, but are not a
  // single-parent subscene hierarchy. Emitting both parents would violate the
  // canonical subscene cardinality and make otherwise valid syncs unreplayable.
  edges.push(...singleParentSubsceneEdges(owner, containmentParents));

  const uniqueNodes = [...new Map(nodes.map((node) => [node.id, node])).values()].sort((left, right) => left.id.localeCompare(right.id));
  const uniqueEdges = [...new Map(edges.map((candidate) => [candidate.id, candidate])).values()].sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: 1,
    projectId: input.projectId,
    sourceRevision: input.sourceRevision,
    definitionFingerprint: fingerprint(input.definitions),
    scenes,
    nodes: uniqueNodes,
    edges: uniqueEdges,
  };
}
