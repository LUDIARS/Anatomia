/**
 * src/scenes/store.ts — Manually-curated scene (局面) definitions.
 *
 * Most projects have no recorded trace, so the scene layer would be empty. This
 * store lets the adjustment view define scenes by hand: a scene = an id, a label,
 * and the domains it activates. Persisted as spec/data/<project>.scenes.json so
 * it is a committed, reviewable artifact alongside the taxonomy.
 *
 * A SceneModel for the panel merges these manual scenes with any trace-derived
 * ones (manual wins on id collision), so a curated scene and a recorded 局面 can
 * coexist.
 *
 * SRP: filesystem read/write + merge of scene definitions. No graph, no HTTP.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SceneRef, SceneModel } from "../integral/scene.js";
import { createSceneModel } from "../integral/scene.js";

interface ScenesFile {
  version: 1;
  project: string;
  scenes: SceneRef[];
}

/** Path to a project's manual scenes file. */
export function scenesPath(repoPath: string, project: string): string {
  return join(repoPath, "spec", "data", `${project}.scenes.json`);
}

/** Load the manual scene definitions (empty when the file is absent/malformed). */
export async function loadScenes(repoPath: string, project: string): Promise<SceneRef[]> {
  try {
    const raw = await readFile(scenesPath(repoPath, project), "utf8");
    const f = JSON.parse(raw) as ScenesFile;
    return f && f.version === 1 && Array.isArray(f.scenes) ? f.scenes : [];
  } catch {
    return [];
  }
}

/** Persist manual scene definitions (sorted by id for a stable diff). */
export async function saveScenes(
  repoPath: string,
  project: string,
  scenes: SceneRef[],
): Promise<void> {
  const dir = join(repoPath, "spec", "data");
  await mkdir(dir, { recursive: true });
  const sorted = [...scenes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const f: ScenesFile = { version: 1, project, scenes: sorted };
  await writeFile(scenesPath(repoPath, project), JSON.stringify(f, null, 2) + "\n", "utf8");
}

/** Merge manual + trace-derived scenes (manual wins on id) into a SceneModel. */
export function mergeSceneModel(manual: SceneRef[], traceScenes: SceneRef[]): SceneModel {
  const byId = new Map<string, SceneRef>();
  for (const s of traceScenes) byId.set(s.id, s);
  for (const s of manual) byId.set(s.id, s); // manual overrides
  return createSceneModel([...byId.values()]);
}
