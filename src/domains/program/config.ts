import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProgramDomainConfig } from "./types.js";

const DEFAULT_CONFIG: ProgramDomainConfig = { layers: [], mergeCouplingThreshold: 1 };

export interface LoadedProgramDomainConfig {
  config: ProgramDomainConfig;
  present: boolean;
}

/** Load the repository-owned layer declaration without inventing a fallback layer. */
export async function loadProgramDomainConfig(repoPath: string): Promise<ProgramDomainConfig> {
  return (await loadProgramDomainConfigWithPresence(repoPath)).config;
}

/** Load the layer declaration and retain whether its file exists, even when it has no rules. */
export async function loadProgramDomainConfigWithPresence(repoPath: string): Promise<LoadedProgramDomainConfig> {
  try {
    const raw = JSON.parse(await readFile(join(repoPath, ".anatomia", "layers.json"), "utf8")) as Partial<ProgramDomainConfig>;
    if (!Array.isArray(raw.layers) || !raw.layers.every((rule) => typeof rule.glob === "string" && typeof rule.layer === "string")) throw new Error("layers must be path-glob/layer declarations");
    const threshold = raw.mergeCouplingThreshold;
    if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0) throw new Error("mergeCouplingThreshold must be a non-negative number");
    return {
      config: { layers: [...raw.layers].sort((left, right) => left.glob.localeCompare(right.glob) || left.layer.localeCompare(right.layer)), mergeCouplingThreshold: threshold },
      present: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: DEFAULT_CONFIG, present: false };
    throw new Error(`invalid .anatomia/layers.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}
