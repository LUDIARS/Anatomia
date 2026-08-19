/**
 * src/knowledge/entrypoint/project-reader.ts — Where the entry artifact lives,
 * and how to read it without re-analysing.
 *
 * The panel and the CLI both want "what did the last sync find" answered from
 * disk. The paths mirror the scene layer's (one write root per project, one
 * generated tree) so a project has a single OKF surface, not one per feature.
 *
 * SRP: path resolution + artifact read.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "../../project/types.js";
import { computeFingerprint } from "../../project/fingerprint.js";
import { computeEntryPointConfigRevision } from "../../entrypoints/config.js";
import { replayKnowledgeLog } from "../log.js";
import { resolveKnowledgeWriteRoot } from "../write-root.js";
import type { EntryPointGraphManifest } from "./types.js";

export interface EntryPointKnowledgePaths {
  writeRoot: string;
  knowledgeLogPath: string;
  generatedRoot: string;
  manifestPath: string;
}

const SAFE_PROJECT_ID = /^[a-z0-9][a-z0-9._~-]*$/;

export function entryPointKnowledgePaths(project: Project): EntryPointKnowledgePaths {
  if (!SAFE_PROJECT_ID.test(project.id)) {
    throw new Error("entry-point knowledge requires a lowercase path-safe project id");
  }
  const writeRoot = resolveKnowledgeWriteRoot(project);
  const generatedRoot = join(writeRoot, "data", "generated", "anatomia");
  return {
    writeRoot,
    knowledgeLogPath: join(writeRoot, "data", "domain-map", `${project.id}.knowledge.jsonl`),
    generatedRoot,
    manifestPath: join(generatedRoot, "entrypoint-graph.json"),
  };
}

/** Source identity of the entry set: project sources + entry config, minus generated data. */
export async function computeEntryPointSourceRevision(project: Project): Promise<string> {
  const paths = entryPointKnowledgePaths(project);
  const fingerprint = await computeFingerprint(project.rootPath, {
    excludeDirs: [join(paths.writeRoot, "data")],
  });
  const configRevision = await computeEntryPointConfigRevision(project.rootPath);
  const digest = createHash("sha256")
    .update(fingerprint, "utf8")
    .update("\0", "utf8")
    .update(configRevision, "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

export interface EntryPointInspection {
  manifest: EntryPointGraphManifest | null;
  knowledgeHead: string | null;
  sourceRevision: string;
  /** True when the artifact does not describe the current sources. */
  stale: boolean;
  staleReasons: string[];
}

function parseEntryPointGraphManifest(text: string): EntryPointGraphManifest {
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("entry-point graph manifest must be an object");
  }
  const manifest = value as Record<string, unknown>;
  const arrays = ["entries", "graphNodes", "graphEdges", "unrooted", "diagnostics"] as const;
  if (manifest["schemaVersion"] !== 1
    || manifest["projectionSchema"] !== 1
    || typeof manifest["projectId"] !== "string"
    || typeof manifest["knowledgeHead"] !== "string"
    || typeof manifest["sourceRevision"] !== "string"
    || typeof manifest["definitionFingerprint"] !== "string"
    || arrays.some((field) => !Array.isArray(manifest[field]))) {
    throw new Error("entry-point graph manifest has an invalid schema");
  }
  return manifest as unknown as EntryPointGraphManifest;
}

/** Read the prepared artifact. Never analyses; a missing artifact is not an error. */
export async function readProjectEntryPointInspection(project: Project): Promise<EntryPointInspection> {
  const paths = entryPointKnowledgePaths(project);
  let knowledgeHead: string | null = null;
  try { knowledgeHead = replayKnowledgeLog(await readFile(paths.knowledgeLogPath, "utf8")).head; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const sourceRevision = await computeEntryPointSourceRevision(project);
  let manifest: EntryPointGraphManifest | null = null;
  try { manifest = parseEntryPointGraphManifest(await readFile(paths.manifestPath, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staleReasons: string[] = [];
  if (!manifest) staleReasons.push("entry-point graph not derived");
  else {
    if (manifest.sourceRevision !== sourceRevision) staleReasons.push("source changed since derivation");
    if (knowledgeHead !== null && manifest.knowledgeHead !== knowledgeHead) staleReasons.push("knowledge head moved");
  }
  return { manifest, knowledgeHead, sourceRevision, stale: staleReasons.length > 0, staleReasons };
}
