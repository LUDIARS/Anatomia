/**
 * `.anatomia/entrypoints.json` の公開入口を、 orphan と区別して扱う。
 * Ludellus の pose detector (`setPoses` / `update` / `reset`) は現在の production 呼び出しが
 * 無いが、 部品の公開契約として保持する。 宣言が無ければ従来どおり orphan のまま。
 */

import { describe, expect, it } from "vitest";
import { declaredEntrypointAnchors } from "../declared-entrypoints.js";
import { defaultEntryPointConfig } from "../../entrypoints/config.js";
import type { AnchorId, FunctionNode } from "../../types.js";

const REPO = "/repo";

function fn(id: string, name: string, file: string, enclosingType?: string): FunctionNode {
  return {
    id: id as AnchorId,
    name,
    signature: `${name}()`,
    ...(enclosingType ? { enclosingType } : {}),
    sourceRange: { start: { line: 0, column: 0 }, end: { line: 1, column: 0 }, filePath: `${REPO}/${file}` },
  };
}

const POSE = "renderer/lib/body-interaction/pose-detector.js";
const functions = [
  fn("factory", "createBodyPoseDetector", POSE),
  fn("setPoses", "setPoses", POSE, "createBodyPoseDetector()"),
  fn("update", "update", POSE, "createBodyPoseDetector()"),
  fn("helper", "matchPose", POSE),
  fn("other", "update", "renderer/lib/body-interaction/touch-detector.js", "createBodyTouchDetector()"),
];

describe("declaredEntrypointAnchors", () => {
  it("declares nothing without include rules", () => {
    expect([...declaredEntrypointAnchors(REPO, functions, defaultEntryPointConfig())]).toEqual([]);
  });

  it("covers a declared factory and the methods of the object it returns", () => {
    const config = { ...defaultEntryPointConfig(), include: [{ symbol: `${POSE}#createBodyPoseDetector` }] };
    expect([...declaredEntrypointAnchors(REPO, functions, config)].sort()).toEqual(["factory", "setPoses", "update"]);
  });

  it("does not leak to a same-named method of another factory, and honours exclude", () => {
    const config = {
      ...defaultEntryPointConfig(),
      include: [{ pathGlob: "renderer/lib/body-interaction/pose-detector.js" }],
      exclude: [{ namePattern: "^matchPose$" }],
    };
    const declared = declaredEntrypointAnchors(REPO, functions, config);
    expect(declared.has("other" as AnchorId)).toBe(false);
    expect(declared.has("helper" as AnchorId)).toBe(false);
    expect(declared.has("update" as AnchorId)).toBe(true);
  });
});
