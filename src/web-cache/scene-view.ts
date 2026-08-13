import type { SceneInspection } from "../knowledge/scene/types.js";
import type { DomainCorrespondenceQuery } from "../knowledge/domain-correspondence/types.js";
import type { ScreenGraph } from "../screens/types.js";
import type { SceneViewPayload } from "./types.js";

/** A capture is served by the local overlay; source anchors must not trigger browser requests elsewhere. */
function isLocalCaptureArtifact(path: string): boolean {
  return /\.(png|jpe?g|webp)$/i.test(path)
    && !/^(?:https?:|[a-z]:[\\/]|[\\/])/i.test(path)
    && !path.split(/[\\/]/).includes("..");
}

/** Shape canonical scenes for the UI without performing source analysis. */
export function buildSceneViewPayload(
  inspection: SceneInspection,
  screens: ScreenGraph,
  correspondence: DomainCorrespondenceQuery,
): SceneViewPayload {
  const programByBusiness = new Map(correspondence.businessDomains.map((row) => [row.businessDomainId, row.programDomains.map((p) => p.programDomainId)]));
  return {
    scenes: inspection.scenes.filter((scene) => !scene.tombstone).map((scene) => {
      const screen = screens.screens.find((candidate) =>
        candidate.name === scene.nativeIdentity || scene.referenceKeys.includes(candidate.name));
      const captureUrl = scene.elements.find((element) => isLocalCaptureArtifact(element.sourceAnchor.path))?.sourceAnchor.path ?? null;
      const fidelity = captureUrl ? "capture" : screen ? "wireframe" : "tree";
      return {
        id: scene.id,
        label: scene.annotation?.label ?? scene.label,
        kind: scene.kind,
        stack: screen?.stack ?? null,
        fidelity,
        captureUrl,
        wireframe: screen ? { nodes: [{ id: screen.name, label: screen.name, kind: screen.kind }, ...screen.contains.map((id) => ({ id, label: id, kind: "contained" }))], transitions: screen.navigatesTo } : null,
        elements: scene.elements.map((element) => ({ id: element.id, label: element.label })),
        businessDomainIds: [...scene.activeDomainIds],
        programDomainIds: [...new Set(scene.activeDomainIds.flatMap((id) => programByBusiness.get(id) ?? []))].sort(),
        transitionSceneIds: [...scene.transitionSceneIds],
      };
    }),
  };
}
