// @spec 導出ロジック
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../knowledge/canonical-json.js";
import type { ProgramDomainManifest } from "../knowledge/program-domain/types.js";
import { webDir } from "./store.js";

/** Persist the deterministic program-domain projection beside prepared web data. */
export async function writeProgramDomainsWebCache(projectCacheDir: string, manifest: ProgramDomainManifest): Promise<void> {
  const directory = webDir(projectCacheDir);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "program-domains.json"), canonicalJson(manifest) + "\n", "utf8");
}

/** Read the latest program-domain projection without recomputing it. */
export async function readProgramDomainsWebCache(projectCacheDir: string): Promise<ProgramDomainManifest | null> {
  try { return JSON.parse(await readFile(join(webDir(projectCacheDir), "program-domains.json"), "utf8")) as ProgramDomainManifest; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
