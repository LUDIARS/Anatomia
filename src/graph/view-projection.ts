/**
 * Class-level projection of the function graph.
 *
 * SRP: collapse member functions to owning class nodes and aggregate member
 * edges into class-to-class edges. The original function graph remains intact.
 */

import { extname, relative } from "node:path";
import type { AnchorId, EdgeKind, FileNode, FunctionNode, SourceRange, TypeDecl } from "../types.js";

export interface ClassViewNode {
  id: string;
  name: string;
  kind: "class" | "function";
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

function fileScopedClassId(repoPath: string, type: TypeDecl): string {
  return `class:${normalizedRelative(repoPath, type.filePath)}:${type.name}`;
}

function classId(
  repoPath: string,
  type: TypeDecl,
  multiFileCSharpTypes: ReadonlySet<string>,
): string {
  if (extname(type.filePath).toLowerCase() === ".cs" && multiFileCSharpTypes.has(type.name)) {
    return `class:csharp:${type.name}`;
  }
  return fileScopedClassId(repoPath, type);
}

function fallbackRange(filePath: string): SourceRange {
  return { filePath, start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
}

/** Collapse methods to owning classes while preserving free functions as nodes. */
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
  const multiFileCSharpTypes = new Set(
    [...declsByName.entries()]
      .filter(([, decls]) => {
        const csharpFiles = new Set(
          decls
            .filter((decl) => extname(decl.filePath).toLowerCase() === ".cs")
            .map((decl) => decl.filePath),
        );
        return csharpFiles.size > 1;
      })
      .map(([name]) => name),
  );

  const nodesById = new Map<string, ClassViewNode>();
  const ownerByAnchor = new Map<AnchorId, string>();
  for (const decl of declarations) {
    const id = classId(repoPath, decl, multiFileCSharpTypes);
    if (nodesById.has(id)) continue;
    nodesById.set(id, {
      id,
      name: decl.name,
      kind: "class",
      sourceRange: decl.sourceRange ?? fallbackRange(decl.filePath),
      memberAnchors: [],
    });
  }

  for (const fn of functions) {
    if (!fn.id) continue;
    if (!fn.enclosingType) {
      nodesById.set(fn.id, {
        id: fn.id,
        name: fn.name,
        kind: "function",
        sourceRange: fn.sourceRange,
        memberAnchors: [fn.id],
      });
      ownerByAnchor.set(fn.id, fn.id);
      continue;
    }
    const candidates = declsByName.get(fn.enclosingType) ?? [];
    const sameFile = candidates.find((decl) => decl.filePath === fn.sourceRange.filePath);
    const ownerDecl = sameFile ?? (candidates.length === 1 ? candidates[0] : undefined);
    const id = ownerDecl
      ? classId(repoPath, ownerDecl, multiFileCSharpTypes)
      : `class:${normalizedRelative(repoPath, fn.sourceRange.filePath)}:${fn.enclosingType}`;
    let node = nodesById.get(id);
    if (!node) {
      node = {
        id,
        name: fn.enclosingType,
        kind: "class",
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
