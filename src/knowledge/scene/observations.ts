import { createHash } from "node:crypto";
import type { SceneDefinitionSeed, SceneObservation } from "./types.js";

export interface RawSceneObservation {
  sceneId?: string | null;
  observedAnchorIds: string[];
  frameRange?: { start: number; end: number } | null;
  phaseLabel?: string | null;
}

function observationId(traceRevision: string, index: number, row: RawSceneObservation): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ traceRevision, index, row }), "utf8")
    .digest("hex").slice(0, 20);
  return `observation:scene/${digest}`;
}

/** Trace rows only attach to definitions; unmatched phases remain diagnostics. */
export function attachSceneObservations(
  definitions: SceneDefinitionSeed[],
  traceRevision: string,
  rows: RawSceneObservation[],
): SceneObservation[] {
  const active = definitions.filter((definition) => !definition.tombstone);
  const byId = new Map(active.map((definition) => [definition.sceneId, definition]));
  return rows.map((row, index) => {
    const exact = row.sceneId ? byId.get(row.sceneId) : undefined;
    const anchorMatches = exact ? [] : active.filter((definition) =>
      row.observedAnchorIds.some((anchor) => definition.entryAnchorIds.includes(anchor)));
    const matched = exact ?? (anchorMatches.length === 1 ? anchorMatches[0] : undefined);
    return {
      observationId: observationId(traceRevision, index, row),
      traceRevision,
      sceneId: matched?.sceneId ?? null,
      observedAnchorIds: [...new Set(row.observedAnchorIds)].sort(),
      frameRange: row.frameRange ?? null,
      confidence: exact ? 1 : matched ? 0.8 : 0,
      provisionalDiagnostic: matched
        ? null
        : `unmatched trace phase${row.phaseLabel ? `: ${row.phaseLabel}` : ""}; no canonical scene created`,
    };
  });
}
