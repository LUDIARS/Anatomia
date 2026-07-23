import { describe, expect, it } from "vitest";
import type { AnchorId, FileNode, FunctionNode, ParamInfo } from "../../types.js";
import { resolveUnityLifecycleFunctions } from "./lifecycle.js";

function fn(
  id: string,
  name: string,
  enclosingType: string,
  opts: { filePath?: string; signature?: string; params?: ParamInfo[]; line?: number } = {},
): FunctionNode {
  return {
    id: id as AnchorId,
    name,
    enclosingType,
    signature: opts.signature ?? `void ${name}()`,
    ...(opts.params ? { params: opts.params } : {}),
    sourceRange: {
      filePath: opts.filePath ?? "/repo/Assets/Test.cs",
      start: { line: opts.line ?? 0, column: 0 },
      end: { line: opts.line ?? 0, column: 1 },
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

  it("rejects static callbacks and same-named overloads with the wrong parameters", () => {
    const validUpdate = fn("valid", "Update", "Player");
    const staticUpdate = fn("static", "Update", "Player", {
      signature: "private static void Update()",
    });
    const overloadedUpdate = fn("overload", "Update", "Player", {
      signature: "private void Update(int frame)",
      params: [{ name: "frame", type: null }],
    });
    const validCollision = fn("collision", "OnCollisionEnter", "Player", {
      signature: "private void OnCollisionEnter(Collision collision)",
      params: [{ name: "collision", type: "Collision" }],
    });
    const wrongCollision = fn("wrong-collision", "OnCollisionEnter", "Player", {
      signature: "private void OnCollisionEnter(Collider collider)",
      params: [{ name: "collider", type: "Collider" }],
    });
    const parameterlessCollision = fn("parameterless-collision", "OnCollisionEnter", "Player");

    const matches = resolveUnityLifecycleFunctions({
      projectProfile: { kind: "unity", defaultGraphView: "class" },
      files,
      functions: [
        validUpdate,
        staticUpdate,
        overloadedUpdate,
        validCollision,
        wrongCollision,
        parameterlessCollision,
      ],
    });

    expect([...matches.keys()]).toEqual([
      validUpdate.id,
      validCollision.id,
      parameterlessCollision.id,
    ]);
  });

  it("resolves duplicate simple type names from the function's own file", () => {
    const unityPath = "/repo/Assets/Game/Player.cs";
    const toolsPath = "/repo/Assets/Tools/Player.cs";
    const duplicateNameFiles: FileNode[] = [
      {
        path: unityPath,
        hash: null,
        functions: [],
        types: [{ name: "Player", bases: ["MonoBehaviour"], filePath: unityPath }],
      },
      {
        path: toolsPath,
        hash: null,
        functions: [],
        types: [{ name: "Player", bases: [], filePath: toolsPath }],
      },
    ];
    const unityUpdate = fn("unity-update", "Update", "Player", { filePath: unityPath });
    const toolsUpdate = fn("tools-update", "Update", "Player", { filePath: toolsPath });

    const matches = resolveUnityLifecycleFunctions({
      projectProfile: { kind: "unity", defaultGraphView: "class" },
      files: duplicateNameFiles,
      functions: [unityUpdate, toolsUpdate],
    });

    expect(matches.has(unityUpdate.id!)).toBe(true);
    expect(matches.has(toolsUpdate.id!)).toBe(false);
  });

  it("uses declaration ranges for duplicate simple names in one source file", () => {
    const path = "/repo/Assets/Players.cs";
    const range = (start: number, end: number) => ({
      filePath: path,
      start: { line: start, column: 0 },
      end: { line: end, column: 0 },
    });
    const sameFile: FileNode[] = [{
      path,
      hash: null,
      functions: [],
      types: [
        { name: "Player", bases: ["MonoBehaviour"], filePath: path, sourceRange: range(0, 10) },
        { name: "Player", bases: [], filePath: path, sourceRange: range(20, 30) },
      ],
    }];
    const unityUpdate = fn("same-file-unity", "Update", "Player", { filePath: path, line: 5 });
    const plainUpdate = fn("same-file-plain", "Update", "Player", { filePath: path, line: 25 });

    const matches = resolveUnityLifecycleFunctions({
      projectProfile: { kind: "unity", defaultGraphView: "class" },
      files: sameFile,
      functions: [unityUpdate, plainUpdate],
    });

    expect(matches.has(unityUpdate.id!)).toBe(true);
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
