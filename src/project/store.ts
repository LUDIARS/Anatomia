/**
 * src/project/store.ts — Registry persistence (projects.json).
 *
 * SRP: read/write the RegistrySnapshot as JSON. No identity logic (registry.ts),
 * no analysis (manager.ts).
 *
 * Location resolution (first wins):
 *   1. explicit `homeDir` argument
 *   2. env ANATOMIA_HOME
 *   3. <cwd>/.anatomia
 * The registry file is `<home>/projects.json`; the cache lives under
 * `<home>/cache/<projectId>/` (see cache.ts). The home dir is created lazily.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectRegistry } from "./registry.js";
import type { RegistrySnapshot } from "./types.js";

/** Resolve the Anatomia home dir (where projects.json + cache/ live). */
export function resolveHome(homeDir?: string): string {
  if (homeDir && homeDir.trim().length > 0) return homeDir;
  const env = process.env.ANATOMIA_HOME;
  if (env && env.trim().length > 0) return env;
  return join(process.cwd(), ".anatomia");
}

/** Absolute path to the registry JSON for a given home. */
export function registryPath(homeDir?: string): string {
  return join(resolveHome(homeDir), "projects.json");
}

/** Absolute path to the cache root for a given home. */
export function cacheRoot(homeDir?: string): string {
  return join(resolveHome(homeDir), "cache");
}

/**
 * Persist a registry's snapshot to `<home>/projects.json` (pretty JSON).
 * Creates the home dir if missing.
 */
export async function saveRegistry(reg: ProjectRegistry, homeDir?: string): Promise<string> {
  const home = resolveHome(homeDir);
  await mkdir(home, { recursive: true });
  const path = join(home, "projects.json");
  const snap = reg.toSnapshot();
  await writeFile(path, JSON.stringify(snap, null, 2) + "\n", "utf8");
  return path;
}

/**
 * Load a registry from `<home>/projects.json`. Returns an empty registry when
 * the file is absent or unreadable (first-run friendly).
 */
export async function loadRegistry(homeDir?: string): Promise<ProjectRegistry> {
  const path = registryPath(homeDir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return new ProjectRegistry();
  }
  let snap: RegistrySnapshot;
  try {
    snap = JSON.parse(raw) as RegistrySnapshot;
  } catch {
    return new ProjectRegistry();
  }
  if (!snap || !Array.isArray(snap.projects)) return new ProjectRegistry();
  snap = migrateSnapshot(snap);
  return ProjectRegistry.fromSnapshot(snap);
}

function migrateSnapshot(snap: RegistrySnapshot): RegistrySnapshot {
  const hasAnatomia = snap.projects.some((p) => p.id === "anatomia");
  if (hasAnatomia) return snap;

  let migrated = false;
  const projects = snap.projects.map((p) => {
    if (p.id !== "default" || p.name !== "default") return p;
    if (pathTail(p.rootPath).toLowerCase() !== "anatomia") return p;
    migrated = true;
    return { ...p, id: "anatomia", name: "anatomia" };
  });
  if (!migrated) return snap;

  return {
    ...snap,
    selected: snap.selected === "default" ? "anatomia" : snap.selected,
    projects,
  };
}

function pathTail(path: string): string {
  return (path || "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || "";
}
