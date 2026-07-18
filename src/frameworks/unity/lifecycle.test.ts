import { describe, expect, it } from "vitest";
import type { AnchorId, FileNode, FunctionNode } from "../../types.js";
import { resolveUnityLifecycleFunctions } from "./lifecycle.js";

function fn(id: string, name: string, enclosingType: string): FunctionNode {
  return {
    id: id as AnchorId,
    name,
    enclosingType,
    signature: `void ${name}()`,
    sourceRange: {
      filePath: "/repo/Assets/Test.cs",
      start: { line: 0, column: 0 },
      end: { line: 0, column: 1 },
    },
    bodyAst: {} as FunctionNode["bodyAst"],
  };
}

const files: FileNode[] = [{
  path: "/repo/Assets/Test.cs",
  hash: null,
  functions: [],
  types: [
    { name: "BaseBehaviour", bases: ["MonoBehaviour"], filePath: "/repo/Assets/Test.cs" },
    { name: "Player", bases: ["BaseBehaviour"], filePath: "/repo/Assets/Test.cs" },
    { name: "Plain", bases: [], filePath: "/repo/Assets/Test.cs" },
  ],
}];

describe("Unity lifecycle map", () => {
  it("resolves documented callbacks through a MonoBehaviour inheritance chain", () => {
    const update = fn("update", "Update", "Player");
    const helper = fn("helper", "Helper", "Player");
    const plainUpdate = fn("plain", "Update", "Plain");
    const matches = resolveUnityLifecycleFunctions({
      projectProfile: { kind: "unity", defaultGraphView: "class" },
      files,
      functions: [update, helper, plainUpdate],
    });
    expect(matches.get(update.id!)?.phase).toBe("update");
    expect(matches.has(helper.id!)).toBe(false);
    expect(matches.has(plainUpdate.id!)).toBe(false);
  });

  it("does not inject Unity semantics into an ordinary C# project", () => {
    const update = fn("update", "Update", "Player");
    const matches = resolveUnityLifecycleFunctions({
      projectProfile: { kind: "generic", defaultGraphView: "class" },
      files,
      functions: [update],
    });
    expect(matches.size).toBe(0);
  });
});
