/**
 * src/scenes/store.test.ts — manual scene load/save + mergeSceneModel.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScenes, saveScenes, mergeSceneModel } from "./store.js";
import type { SceneRef } from "../integral/scene.js";

let repo: string;
beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "anatomia-scenes-"));
});
afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("scenes store", () => {
  it("round-trips manual scenes (sorted by id)", async () => {
    await saveScenes(repo, "proj", [
      { id: "b", label: "B", domains: ["combat"] },
      { id: "a", domains: ["ui", "combat"] },
    ]);
    const loaded = await loadScenes(repo, "proj");
    expect(loaded.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("returns [] when no scenes file exists", async () => {
    expect(await loadScenes(repo, "missing")).toEqual([]);
  });
});

describe("mergeSceneModel", () => {
  it("merges manual + trace scenes, manual winning on id collision", () => {
    const trace: SceneRef[] = [
      { id: "phase-1", domains: ["combat"] },
      { id: "shared", domains: ["trace-only"] },
    ];
    const manual: SceneRef[] = [
      { id: "shared", label: "curated", domains: ["combat", "ui"] },
      { id: "menu", domains: ["ui"] },
    ];
    const model = mergeSceneModel(manual, trace);
    expect(model.scenes().map((s) => s.id).sort()).toEqual(["menu", "phase-1", "shared"]);
    // manual wins
    expect(model.sceneById("shared")?.label).toBe("curated");
    expect(model.sceneById("shared")?.domains).toEqual(["combat", "ui"]);
    // domain → scenes
    expect(model.scenesForDomain("ui").map((s) => s.id).sort()).toEqual(["menu", "shared"]);
  });
});
