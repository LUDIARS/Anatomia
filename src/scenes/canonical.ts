import { createSceneModel, type SceneModel } from "../integral/scene.js";
import type { SceneInspection } from "../knowledge/scene/types.js";

/** Compatibility view over the single canonical manifest reader result. */
export function sceneModelFromInspection(inspection: SceneInspection): SceneModel {
  return createSceneModel(inspection.scenes
    .filter((scene) => !scene.tombstone)
    .map((scene) => ({
      id: scene.id,
      label: scene.annotation?.label ?? scene.label,
      domains: [...scene.activeDomainIds],
    })));
}
