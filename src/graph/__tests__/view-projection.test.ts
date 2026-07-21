import { describe, expect, it } from "vitest";
import type { AnchorId, Edge, FileNode, FunctionNode, SourceRange } from "../../types.js";
import { projectClassView } from "../view-projection.js";

const range = (filePath: string, line: number): SourceRange => ({
  filePath,
  start: { line, column: 0 },
  end: { line, column: 1 },
});

function method(id: string, name: string, owner: string, filePath: string): FunctionNode {
  return {
    id: id as AnchorId,
    name,
    enclosingType: owner,
    signature: `void ${name}()`,
    sourceRange: range(filePath, 1),
    bodyAst: {} as FunctionNode["bodyAst"],
  };
}

function freeFn(id: string, name: string, filePath: string): FunctionNode {
  return {
    id: id as AnchorId,
    name,
    signature: `void ${name}()`,
    sourceRange: range(filePath, 1),
    bodyAst: {} as FunctionNode["bodyAst"],
  };
}

describe("class graph projection", () => {
  it("keeps member edges in the function graph input and aggregates them between classes", () => {
    const path = "/repo/Assets/Test.cs";
    const a1 = method("a1", "Run", "A", path);
    const a2 = method("a2", "Retry", "A", path);
    const b = method("b", "Tick", "B", path);
    const files: FileNode[] = [{
      path,
      hash: null,
      functions: [a1, a2, b],
      types: [
        { name: "A", bases: [], filePath: path, sourceRange: range(path, 0) },
        { name: "B", bases: [], filePath: path, sourceRange: range(path, 5) },
      ],
    }];
    const edges: Edge[] = [
      { from: a1.id!, to: b.id!, kind: "calls" },
      { from: a2.id!, to: b.id!, kind: "calls" },
      { from: a1.id!, to: a2.id!, kind: "calls" },
    ];

    const view = projectClassView("/repo", files, files[0]!.functions, edges);
    expect(edges).toHaveLength(3);
    expect(view.nodes.map((node) => node.name)).toEqual(["A", "B"]);
    expect(view.edges).toHaveLength(1);
    expect(view.edges[0]).toMatchObject({ kind: "calls", memberEdgeCount: 2 });
  });

  it("merges a partial class declared across files into one node", () => {
    const fileA = "/repo/Widget.Part1.cs";
    const fileB = "/repo/Widget.Part2.cs";
    const m1 = method("m1", "Init", "Widget", fileA);
    const m2 = method("m2", "Tick", "Widget", fileB);
    const files: FileNode[] = [
      {
        path: fileA, hash: null, functions: [m1],
        types: [{ name: "Widget", bases: [], filePath: fileA, sourceRange: range(fileA, 0) }],
      },
      {
        path: fileB, hash: null, functions: [m2],
        types: [{ name: "Widget", bases: [], filePath: fileB, sourceRange: range(fileB, 0) }],
      },
    ];
    // Intra-class call across the two partial files.
    const edges: Edge[] = [{ from: m1.id!, to: m2.id!, kind: "calls" }];

    const view = projectClassView("/repo", files, [m1, m2], edges);
    expect(view.nodes.map((node) => node.name)).toEqual(["Widget"]);
    expect(view.nodes[0]!.memberAnchors).toEqual(["m1", "m2"]);
    // The intra-class call must not surface as a cross-class edge.
    expect(view.edges).toHaveLength(0);
  });

  it("keeps free functions as their own nodes and edges", () => {
    const path = "/repo/util.cpp";
    const f1 = freeFn("f1", "helper", path);
    const f2 = freeFn("f2", "worker", path);
    const files: FileNode[] = [{ path, hash: null, functions: [f1, f2], types: [] }];
    const edges: Edge[] = [{ from: f1.id!, to: f2.id!, kind: "calls" }];

    const view = projectClassView("/repo", files, [f1, f2], edges);
    expect(view.nodes.map((node) => node.name).sort()).toEqual(["helper", "worker"]);
    expect(view.edges).toHaveLength(1);
    expect(view.edges[0]).toMatchObject({ kind: "calls", memberEdgeCount: 1 });
  });
});
