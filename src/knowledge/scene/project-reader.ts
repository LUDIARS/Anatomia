import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "../../project/types.js";
import { computeFingerprint } from "../../project/fingerprint.js";
import { specLinksPath } from "../../spec/persist.js";
import { replayKnowledgeLog } from "../log.js";
import { resolveKnowledgeWriteRoot } from "../write-root.js";
import { readSceneAnnotations, readSceneManifest } from "./reader.js";
import type { SceneInspection } from "./types.js";

export interface SceneKnowledgePaths {
  writeRoot: string;
  knowledgeLogPath: string;
  generatedRoot: string;
  manifestPath: string;
}

const SAFE_PROJECT_ID = /^[a-z0-9][a-z0-9._~-]*$/;

export function sceneKnowledgePaths(project: Project): SceneKnowledgePaths {
  if (!SAFE_PROJECT_ID.test(project.id)) {
    throw new Error("scene knowledge requires a lowercase path-safe project id");
  }
  const writeRoot = resolveKnowledgeWriteRoot(project);
  const generatedRoot = join(writeRoot, "data", "generated", "anatomia");
  return {
    writeRoot,
    knowledgeLogPath: join(writeRoot, "data", "domain-map", `${project.id}.knowledge.jsonl`),
    generatedRoot,
    manifestPath: join(generatedRoot, "scene-manifest.json"),
  };
}

export async function computeSceneSourceRevision(project: Project): Promise<string> {
  const paths = sceneKnowledgePaths(project);
  const fingerprint = await computeFingerprint(project.rootPath, {
    excludeDirs: [join(paths.writeRoot, "data")],
  });
  let approvedLinks = "<missing>";
  try { approvedLinks = await readFile(specLinksPath(project.rootPath), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const digest = createHash("sha256")
    .update(fingerprint, "utf8")
    .update("\0", "utf8")
    .update(approvedLinks, "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

export async function readProjectSceneInspection(project: Project): Promise<SceneInspection> {
  const paths = sceneKnowledgePaths(project);
  let head: string | null = null;
  try { head = replayKnowledgeLog(await readFile(paths.knowledgeLogPath, "utf8")).head; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return readSceneManifest(paths.manifestPath, {
    projectId: project.id,
    knowledgeHead: head,
    sourceRevision: await computeSceneSourceRevision(project),
  }, await readSceneAnnotations(join(paths.writeRoot, "data", "scene-annotations")));
}
