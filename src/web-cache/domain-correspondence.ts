import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../knowledge/canonical-json.js";
import { deriveDomainCorrespondence } from "../knowledge/domain-correspondence/derive.js";
import type { DomainCorrespondenceQuery } from "../knowledge/domain-correspondence/types.js";
import type { KnowledgeGraph } from "../knowledge/types.js";
import { webDir } from "./store.js";

const FILE_NAME = "domain-correspondence.json";

/** Prepare and persist the query-only dual-layer projection once per web-cache refresh. */
export async function prepareDomainCorrespondenceWebCache(
  projectCacheDir: string,
  state: KnowledgeGraph,
): Promise<DomainCorrespondenceQuery> {
  const correspondence = deriveDomainCorrespondence(state);
  const directory = webDir(projectCacheDir);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, FILE_NAME), canonicalJson(correspondence) + "\n", "utf8");
  return correspondence;
}

/** Read the prepared dual-layer projection; queries never replay or reparse source data. */
export async function readDomainCorrespondenceWebCache(projectCacheDir: string): Promise<DomainCorrespondenceQuery | null> {
  try {
    return JSON.parse(await readFile(join(webDir(projectCacheDir), FILE_NAME), "utf8")) as DomainCorrespondenceQuery;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
