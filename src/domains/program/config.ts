import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProgramDomainConfig } from "./types.js";

const DEFAULT_CONFIG: ProgramDomainConfig = { layers: [], mergeCouplingThreshold: 1 };

/** Load the repository-owned layer declaration without inventing a fallback layer. */
export async function loadProgramDomainConfig(repoPath: string): Promise<ProgramDomainConfig> {
  try {
    const raw = JSON.parse(await readFile(join(repoPath, ".anatomia", "layers.json"), "utf8")) as Partial<ProgramDomainConfig>;
    if (!Array.isArray(raw.layers) || !raw.layers.every((rule) => typeof rule.glob === "string" && typeof rule.layer === "string")) throw new Error("layers must be path-glob/layer declarations");
    if (!Number.isFinite(raw.mergeCouplingThreshold) || raw.mergeCouplingThreshold! < 0) throw new Error("mergeCouplingThreshold must be a non-negative number");
    return { layers: [...raw.layers].sort((left, right) => left.glob.localeCompare(right.glob) || left.layer.localeCompare(right.layer)), mergeCouplingThreshold: raw.mergeCouplingThreshold! };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
    throw new Error(`invalid .anatomia/layers.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}
