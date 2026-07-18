/**
 * Class-level projection of the function graph.
 *
 * SRP: collapse member functions to owning class nodes and aggregate member
 * edges into class-to-class edges. The original function graph remains intact.
 */

import { relative } from "node:path";
import type { AnchorId, EdgeKind, FileNode, FunctionNode, SourceRange, TypeDecl } from "../types.js";

export interface ClassViewNode {
  id: string;
  name: string;
  sourceRange: SourceRange;
  memberAnchors: AnchorId[];
}

export interface ClassViewEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  memberEdgeCount: number;
}

export interface ClassViewProjection {
  nodes: ClassViewNode[];
  edges: ClassViewEdge[];
}

function normalizedRelative(repoPath: string, path: string): string {
  try {
    return relative(repoPath, path).replace(/\\/g, "/");
  } catch {
    return path.replace(/\\/g, "/");
  }
}

function classId(repoPath: string, type: TypeDecl): string {
  return `class:${normalizedRelative(repoPath, type.filePath)}:${type.name}`;
}

function fallbackRange(filePath: string): SourceRange {
  return { filePath, start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
}

/** Collapse only member-to-member edges; free functions stay in function view. */
export function projectClassView(
  repoPath: string,
  files: readonly FileNode[],
  functions: readonly FunctionNode[],
  edges: readonly { from: AnchorId; to: AnchorId; kind: EdgeKind }[],
): ClassViewProjection {
  const declarations = files.flatMap((file) => file.types ?? []);
  const declsByName = new Map<string, TypeDecl[]>();
  for (const decl of declarations) {
    const list = declsByName.get(decl.name);
    if (list) list.push(decl);
    else declsByName.set(decl.name, [decl]);
  }

  const nodesById = new Map<string, ClassViewNode>();
  const ownerByAnchor = new Map<AnchorId, string>();
  for (const decl of declarations) {
    const id = classId(repoPath, decl);
    nodesById.set(id, {
      id,
      name: decl.name,
      sourceRange: decl.sourceRange ?? fallbackRange(decl.filePath),
      memberAnchors: [],
    });
  }

  for (const fn of functions) {
    if (!fn.id || !fn.enclosingType) continue;
    const candidates = declsByName.get(fn.enclosingType) ?? [];
    const sameFile = candidates.find((decl) => decl.filePath === fn.sourceRange.filePath);
    const ownerDecl = sameFile ?? (candidates.length === 1 ? candidates[0] : undefined);
    const id = ownerDecl
      ? classId(repoPath, ownerDecl)
      : `class:${normalizedRelative(repoPath, fn.sourceRange.filePath)}:${fn.enclosingType}`;
    let node = nodesById.get(id);
    if (!node) {
      node = { id, name: fn.enclosingType, sourceRange: fn.sourceRange, memberAnchors: [] };
      nodesById.set(id, node);
    }
    node.memberAnchors.push(fn.id);
    ownerByAnchor.set(fn.id, id);
  }

  const edgesByKey = new Map<string, ClassViewEdge>();
  for (const edge of edges) {
    const from = ownerByAnchor.get(edge.from);
    const to = ownerByAnchor.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from}\0${to}\0${edge.kind}`;
    const existing = edgesByKey.get(key);
    if (existing) existing.memberEdgeCount++;
    else edgesByKey.set(key, { from, to, kind: edge.kind, memberEdgeCount: 1 });
  }

  return {
    nodes: [...nodesById.values()]
      .map((node) => ({ ...node, memberAnchors: [...new Set(node.memberAnchors)].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edgesByKey.values()].sort(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind),
    ),
  };
}
