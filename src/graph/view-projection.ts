/**
 * Class-level projection of the function graph.
 *
 * SRP: collapse member functions to owning class nodes and aggregate member
 * edges into class-to-class edges. The original function graph remains intact.
 */

import type { AnchorId, EdgeKind, FileNode, FunctionNode, SourceRange } from "../types.js";

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

/**
 * Class nodes are keyed by class name ALONE (not name+file). A C# `partial`
 * class is declared across several files under one name; keying by file would
 * split it into a node per file and surface its intra-class calls as false
 * cross-class edges. Keying by name collapses the partials into one node.
 *
 * Trade-off: two unrelated classes sharing a simple name (distinct namespaces)
 * also merge here. That is acceptable for a display projection — TypeDecl does
 * not carry namespace/qualified-name data to disambiguate them.
 */
function classId(name: string): string {
  return `class:${name}`;
}

/**
 * A free function (no enclosing class) becomes its own node in the class view.
 * Dropping them left class-centric C++ repos — where much of the code is free
 * functions — with a near-empty class graph. Keyed by the function's own anchor
 * so overloads stay distinct and edges resolve exactly.
 */
function freeFunctionId(anchor: AnchorId): string {
  return `free:${anchor}`;
}

function fallbackRange(filePath: string): SourceRange {
  return { filePath, start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
}

/**
 * Collapse member-to-member edges into class-to-class edges; free functions are
 * kept as their own nodes so the class view is not empty for free-function-heavy
 * (typically C++) repositories.
 */
export function projectClassView(
  repoPath: string,
  files: readonly FileNode[],
  functions: readonly FunctionNode[],
  edges: readonly { from: AnchorId; to: AnchorId; kind: EdgeKind }[],
): ClassViewProjection {
  const declarations = files.flatMap((file) => file.types ?? []);

  const nodesById = new Map<string, ClassViewNode>();
  const ownerByAnchor = new Map<AnchorId, string>();
  for (const decl of declarations) {
    const id = classId(decl.name);
    // Partial classes share an id; keep the first declaration's range.
    const existing = nodesById.get(id);
    if (existing) {
      if (decl.sourceRange && existing.sourceRange.start.line === 0) {
        existing.sourceRange = decl.sourceRange;
      }
      continue;
    }
    nodesById.set(id, {
      id,
      name: decl.name,
      sourceRange: decl.sourceRange ?? fallbackRange(decl.filePath),
      memberAnchors: [],
    });
  }

  for (const fn of functions) {
    if (!fn.id) continue;
    const id = fn.enclosingType ? classId(fn.enclosingType) : freeFunctionId(fn.id);
    let node = nodesById.get(id);
    if (!node) {
      node = {
        id,
        name: fn.enclosingType ?? fn.name,
        sourceRange: fn.sourceRange,
        memberAnchors: [],
      };
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
