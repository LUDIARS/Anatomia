import { describe, expect, it } from "vitest";
import type { AnchorId, FileNode, FunctionNode } from "../../types.js";
import { resolveUnityLifecycleFunctions } from "./lifecycle.js";

function fn(
  id: string,
  name: string,
  enclosingType: string,
  opts: { signature?: string; filePath?: string } = {},
): FunctionNode {
  const filePath = opts.filePath ?? "/repo/Assets/Test.cs";
  return {
    id: id as AnchorId,
    name,
    enclosingType,
    signature: opts.signature ?? `void ${name}()`,
    sourceRange: {
      filePath,
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

  it("excludes same-named overloads and static methods by signature/modifier", () => {
    const callback = fn("cb", "Update", "Player"); // void Update()
    const overload = fn("ovl", "Update", "Player", { signature: "void Update(float dt)" });
    const staticFn = fn("stat", "Update", "Player", { signature: "static void Update()" });
    const matches = resolveUnityLifecycleFunctions({
      projectProfile: { kind: "unity", defaultGraphView: "class" },
      files,
      functions: [callback, overload, staticFn],
    });
    expect(matches.has(callback.id!)).toBe(true);
    expect(matches.has(overload.id!)).toBe(false);
    expect(matches.has(staticFn.id!)).toBe(false);
  });

  it("accepts the documented arity for parameterised messages", () => {
    const trigger = fn("t", "OnTriggerEnter", "Player", { signature: "void OnTriggerEnter(Collider c)" });
    const badTrigger = fn("bt", "OnTriggerEnter", "Player", { signature: "void OnTriggerEnter()" });
    const matches = resolveUnityLifecycleFunctions({
      projectProfile: { kind: "unity", defaultGraphView: "class" },
      files,
      functions: [trigger, badTrigger],
    });
    expect(matches.get(trigger.id!)?.phase).toBe("physics");
    expect(matches.has(badTrigger.id!)).toBe(false);
  });

  it("does not merge same-named classes across files when resolving MonoBehaviour", () => {
    // Two unrelated classes both named `Widget`: one derives MonoBehaviour, the
    // other is a plain POCO in a different file. The plain one's Update() must NOT
    // be tagged as a lifecycle callback via the other's base list.
    const unityFile = "/repo/Assets/UnityWidget.cs";
    const plainFile = "/repo/Assets/PlainWidget.cs";
    const twoFiles: FileNode[] = [
      {
        path: unityFile,
        hash: null,
        functions: [],
        types: [{ name: "Widget", bases: ["MonoBehaviour"], filePath: unityFile }],
      },
      {
        path: plainFile,
        hash: null,
        functions: [],
        types: [{ name: "Widget", bases: [], filePath: plainFile }],
      },
    ];
    const unityUpdate = fn("uu", "Update", "Widget", { filePath: unityFile });
    const plainUpdate = fn("pu", "Update", "Widget", { filePath: plainFile });
    const matches = resolveUnityLifecycleFunctions({
      projectProfile: { kind: "unity", defaultGraphView: "class" },
      files: twoFiles,
      functions: [unityUpdate, plainUpdate],
    });
    expect(matches.has(unityUpdate.id!)).toBe(true);
    expect(matches.has(plainUpdate.id!)).toBe(false);
  });
});
