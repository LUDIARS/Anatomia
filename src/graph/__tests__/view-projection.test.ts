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

function freeFunction(id: string, name: string, filePath: string): FunctionNode {
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

  it("keeps free functions and their edges in class-centric projections", () => {
    const path = "/repo/src/main.cpp";
    const main = freeFunction("main", "main", path);
    const tick = freeFunction("tick", "tick", path);
    const files: FileNode[] = [{ path, hash: null, functions: [main, tick], types: [] }];
    const edges: Edge[] = [{ from: main.id!, to: tick.id!, kind: "calls" }];

    const view = projectClassView("/repo", files, files[0]!.functions, edges);

    expect(view.nodes.map((node) => ({ name: node.name, kind: node.kind }))).toEqual([
      { name: "main", kind: "function" },
      { name: "tick", kind: "function" },
    ]);
    expect(view.edges).toEqual([
      { from: main.id, to: tick.id, kind: "calls", memberEdgeCount: 1 },
    ]);
  });

  it("merges C# partial class declarations across files", () => {
    const firstPath = "/repo/Assets/Partial.First.cs";
    const secondPath = "/repo/Assets/Partial.Second.cs";
    const first = method("first", "First", "Player", firstPath);
    const second = method("second", "Second", "Player", secondPath);
    const partialFiles: FileNode[] = [
      {
        path: firstPath,
        hash: null,
        functions: [first],
        types: [{ name: "Player", bases: [], filePath: firstPath, sourceRange: range(firstPath, 0) }],
      },
      {
        path: secondPath,
        hash: null,
        functions: [second],
        types: [{ name: "Player", bases: [], filePath: secondPath, sourceRange: range(secondPath, 0) }],
      },
    ];
    const edges: Edge[] = [{ from: first.id!, to: second.id!, kind: "calls" }];

    const view = projectClassView("/repo", partialFiles, [first, second], edges);

    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]).toMatchObject({
      name: "Player",
      kind: "class",
      memberAnchors: [first.id, second.id],
    });
    expect(view.edges).toEqual([]);
  });
});
