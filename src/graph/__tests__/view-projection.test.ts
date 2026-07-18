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
});
