import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseOkfFile } from "../okf-parser.js";
import type { SceneAnnotation, SceneInspection, SceneManifest, SceneObservation } from "./types.js";

export interface SceneManifestExpectation {
  projectId?: string;
  knowledgeHead?: string | null;
  sourceRevision?: string;
  definitionFingerprint?: string;
}

const ANNOTATION_KEYS = new Set(["sceneId", "label", "description", "reviewNote"]);

export function validateSceneAnnotation(value: SceneAnnotation): SceneAnnotation {
  for (const key of Object.keys(value)) {
    if (!ANNOTATION_KEYS.has(key)) throw new Error(`scene annotation cannot override authoritative field ${key}`);
  }
  if (!value.sceneId?.trim()) throw new Error("scene annotation requires sceneId");
  return {
    sceneId: value.sceneId.trim(),
    ...(value.label !== undefined ? { label: value.label } : {}),
    ...(value.description !== undefined ? { description: value.description } : {}),
    ...(value.reviewNote !== undefined ? { reviewNote: value.reviewNote } : {}),
  };
}

export async function readSceneAnnotations(annotationRoot: string): Promise<SceneAnnotation[]> {
  let names: string[];
  try { names = await readdir(annotationRoot); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const annotations: SceneAnnotation[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".md")).sort()) {
    const path = join(annotationRoot, name);
    const document = await parseOkfFile(path, { annotationRoot });
    if (document.route !== "scene-annotation") throw new Error(`invalid scene annotation route: ${path}`);
    const extension = document.profile.raw["x-anatomia"] as Record<string, unknown>;
    const allowed = new Set(["kind", "id", "scene-id", "label", "description", "review-note"]);
    for (const key of Object.keys(extension)) {
      if (!allowed.has(key)) throw new Error(`scene annotation cannot override authoritative field ${key}`);
    }
    annotations.push(validateSceneAnnotation({
      sceneId: String(extension["scene-id"] ?? ""),
      ...(typeof extension.label === "string" ? { label: extension.label } : {}),
      ...(typeof extension.description === "string" ? { description: extension.description } : {}),
      ...(typeof extension["review-note"] === "string" ? { reviewNote: extension["review-note"] } : {}),
    }));
  }
  return annotations;
}

function validateManifest(value: unknown): SceneManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("scene manifest must be an object");
  const manifest = value as SceneManifest;
  if (manifest.schemaVersion !== 1 || manifest.projectionSchema !== 1) {
    throw new Error("scene manifest schema is unsupported");
  }
  if (!manifest.projectId || !manifest.knowledgeHead || !manifest.sourceRevision || !manifest.definitionFingerprint) {
    throw new Error("scene manifest metadata is incomplete");
  }
  if (!Array.isArray(manifest.scenes)) throw new Error("scene manifest scenes must be an array");
  return manifest;
}

export async function readSceneManifest(
  manifestPath: string,
  expectation: SceneManifestExpectation = {},
  annotations: SceneAnnotation[] = [],
  observations: SceneObservation[] = [],
): Promise<SceneInspection> {
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const staleReasons: string[] = [];
  if (expectation.projectId !== undefined && manifest.projectId !== expectation.projectId) staleReasons.push("project-id-mismatch");
  if (expectation.knowledgeHead !== undefined && manifest.knowledgeHead !== expectation.knowledgeHead) staleReasons.push("knowledge-head-mismatch");
  if (expectation.sourceRevision !== undefined && manifest.sourceRevision !== expectation.sourceRevision) staleReasons.push("source-revision-mismatch");
  if (expectation.definitionFingerprint !== undefined
    && manifest.definitionFingerprint !== expectation.definitionFingerprint) staleReasons.push("definition-fingerprint-mismatch");
  const annotationByScene = new Map(annotations.map(validateSceneAnnotation).map((annotation) => [annotation.sceneId, annotation]));
  return {
    manifest,
    scenes: manifest.scenes.map((scene) => ({ ...scene, annotation: annotationByScene.get(scene.id) ?? null })),
    observations: observations.filter((observation) => observation.sceneId !== null
      && manifest.scenes.some((scene) => scene.id === observation.sceneId)),
    stale: staleReasons.length > 0,
    staleReasons,
  };
}
