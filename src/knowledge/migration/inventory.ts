import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Project } from "../../project/types.js";
import type { DomainDef } from "../../domains/ontology.js";
import type { Taxonomy } from "../../domains/retune/types.js";
import type { ScreenGraph } from "../../screens/index.js";
import type { SceneRef } from "../../integral/scene.js";
import { canonicalJson } from "../canonical-json.js";
import type { LegacyArtifactInventory, LegacyArtifactKind, LegacyMigrationConflict } from "./types.js";

// @implements SPEC-knowledge-adapter-migration

export interface LegacyInventoryData {
  artifacts: LegacyArtifactInventory[];
  domains: Array<{ definition: DomainDef; path: string }>;
  taxonomy: Taxonomy | null;
  screens: ScreenGraph | null;
  manualScenes: SceneRef[];
  conflicts: LegacyMigrationConflict[];
}

function hash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

async function optionalText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function artifact(kind: LegacyArtifactKind, path: string, text: string | null, count: number): LegacyArtifactInventory {
  return { kind, path, exists: text !== null, recordCount: count, contentHash: text === null ? null : hash(text) };
}

function repositoryPath(repoRoot: string, path: string): string {
  const child = relative(resolve(repoRoot), resolve(path));
  if (child === "" || child.startsWith("..") || isAbsolute(child)) {
    throw new Error("legacy artifact path escapes project root");
  }
  return child.replace(/\\/g, "/");
}

function dataArtifactPath(repoRoot: string, dataRoot: string, projectName: string, suffix: string): string {
  const path = resolve(dataRoot, `${projectName}.${suffix}.json`);
  const child = relative(resolve(dataRoot), path);
  if (child === "" || child.startsWith("..") || isAbsolute(child)) {
    throw new Error("project name is not safe for legacy artifact lookup");
  }
  repositoryPath(repoRoot, path);
  return path;
}

function domainShape(value: unknown): value is DomainDef {
  const item = value as Partial<DomainDef> | null;
  return Boolean(item && typeof item.name === "string" && typeof item.description === "string"
    && Array.isArray(item.presetRules) && Array.isArray(item.templateRules));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function taxonomyShape(value: unknown): value is Taxonomy {
  if (!isRecord(value) || value["version"] !== 1 || typeof value["project"] !== "string"
    || typeof value["iterations"] !== "number" || !Array.isArray(value["domains"])) return false;
  return value["domains"].every((domain) => isRecord(domain)
    && typeof domain["name"] === "string" && typeof domain["description"] === "string"
    && Array.isArray(domain["modules"])
    && domain["modules"].every((module) => isRecord(module)
      && typeof module["name"] === "string" && typeof module["description"] === "string"
      && strings(module["paths"]) && (module["names"] === undefined || strings(module["names"]))));
}

function screenGraphShape(value: unknown): value is ScreenGraph {
  if (!isRecord(value) || !Array.isArray(value["screens"]) || !isRecord(value["summary"])) return false;
  return value["screens"].every((screen) => isRecord(screen)
    && typeof screen["name"] === "string" && typeof screen["file"] === "string"
    && typeof screen["line"] === "number" && typeof screen["kind"] === "string"
    && typeof screen["stack"] === "string" && strings(screen["contains"])
    && strings(screen["navigatesTo"]) && typeof screen["reason"] === "string" && strings(screen["domains"]));
}

function manualScenesShape(value: unknown): value is { scenes?: SceneRef[] } {
  return isRecord(value) && (value["scenes"] === undefined || (Array.isArray(value["scenes"])
    && value["scenes"].every((scene) => isRecord(scene) && typeof scene["id"] === "string"
      && (scene["label"] === undefined || typeof scene["label"] === "string") && strings(scene["domains"]))));
}

async function inventoryDomainDir(
  repoRoot: string,
  path: string,
  kind: "editable-domain" | "domain-def",
  artifacts: LegacyArtifactInventory[],
  conflicts: LegacyMigrationConflict[],
): Promise<Array<{ definition: DomainDef; path: string }>> {
  let names: string[];
  try { names = await readdir(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      artifacts.push(artifact(kind, repositoryPath(repoRoot, path), null, 0));
      return [];
    }
    throw error;
  }
  const definitions: Array<{ definition: DomainDef; path: string }> = [];
  const texts: string[] = [];
  for (const name of names.sort()) {
    const file = join(path, name);
    if (!name.endsWith(".json")) {
      if (name.endsWith(".mjs") || name.endsWith(".js")) {
        conflicts.push({ code: "invalid-artifact", path: repositoryPath(repoRoot, file), detail: "executable DomainDef is inventoried but never executed by migration" });
      }
      continue;
    }
    const text = await readFile(file, "utf8");
    texts.push(text);
    try {
      const parsed = JSON.parse(text) as unknown;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const candidate of list) {
        if (!domainShape(candidate)) throw new Error("not a DomainDef");
        definitions.push({ definition: candidate, path: repositoryPath(repoRoot, file) });
      }
    } catch (error) {
      conflicts.push({ code: "invalid-artifact", path: repositoryPath(repoRoot, file), detail: error instanceof Error ? error.message : String(error) });
    }
  }
  const combined = texts.length > 0 ? texts.join("\n") : "";
  artifacts.push(artifact(kind, repositoryPath(repoRoot, path), combined, definitions.length));
  return definitions;
}

async function jsonArtifact<T>(
  repoRoot: string,
  kind: "taxonomy" | "screens" | "manual-scenes",
  path: string,
  validate: (value: unknown) => value is T,
  count: (value: T) => number,
  conflicts: LegacyMigrationConflict[],
): Promise<{ value: T | null; inventory: LegacyArtifactInventory }> {
  const text = await optionalText(path);
  const displayPath = repositoryPath(repoRoot, path);
  if (text === null) return { value: null, inventory: artifact(kind, displayPath, null, 0) };
  try {
    const value = JSON.parse(text) as unknown;
    if (!validate(value)) throw new Error(`invalid ${kind} shape`);
    return { value, inventory: artifact(kind, displayPath, text, count(value)) };
  } catch (error) {
    conflicts.push({ code: "invalid-artifact", path: displayPath, detail: error instanceof Error ? error.message : String(error) });
    return { value: null, inventory: artifact(kind, displayPath, text, 0) };
  }
}

export async function inventoryLegacyKnowledge(project: Project): Promise<LegacyInventoryData> {
  const artifacts: LegacyArtifactInventory[] = [];
  const conflicts: LegacyMigrationConflict[] = [];
  const editable = await inventoryDomainDir(project.rootPath, join(project.rootPath, ".anatomia", "domains"), "editable-domain", artifacts, conflicts);
  const committed = await inventoryDomainDir(project.rootPath, join(project.rootPath, "spec", "data", "ontology"), "domain-def", artifacts, conflicts);
  const dataRoot = join(project.rootPath, "spec", "data");
  const taxonomyResult = await jsonArtifact<Taxonomy>(project.rootPath, "taxonomy", dataArtifactPath(project.rootPath, dataRoot, project.name, "taxonomy"), taxonomyShape,
    (value) => Array.isArray(value.domains) ? value.domains.length : 0, conflicts);
  const screensResult = await jsonArtifact<ScreenGraph>(project.rootPath, "screens", dataArtifactPath(project.rootPath, dataRoot, project.name, "screens"), screenGraphShape,
    (value) => Array.isArray(value.screens) ? value.screens.length : 0, conflicts);
  const scenesResult = await jsonArtifact<{ scenes?: SceneRef[] }>(project.rootPath, "manual-scenes", dataArtifactPath(project.rootPath, dataRoot, project.name, "scenes"), manualScenesShape,
    (value) => Array.isArray(value.scenes) ? value.scenes.length : 0, conflicts);
  artifacts.push(taxonomyResult.inventory, screensResult.inventory, scenesResult.inventory);
  return {
    artifacts,
    domains: [...editable, ...committed],
    taxonomy: taxonomyResult.value,
    screens: screensResult.value,
    manualScenes: scenesResult.value?.scenes ?? [],
    conflicts,
  };
}

export function legacyInventoryFingerprint(inventory: LegacyArtifactInventory[]): string {
  return `sha256:${createHash("sha256").update(canonicalJson(inventory), "utf8").digest("hex")}`;
}
