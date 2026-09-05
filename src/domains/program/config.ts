import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateLayerDeclaration } from "./layer-policy.js";
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
    const order = readOrder(raw);
    const allow = readAllow(raw);
    validateLayerDeclaration({ ...(order ? { order } : {}), ...(allow ? { allow } : {}) }, raw.layers);
    return {
      config: {
        layers: [...raw.layers].sort((left, right) => left.glob.localeCompare(right.glob) || left.layer.localeCompare(right.layer)),
        mergeCouplingThreshold: threshold,
        ...(order ? { order } : {}),
        ...(allow ? { allow } : {}),
      },
      present: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: DEFAULT_CONFIG, present: false };
    throw new Error(`invalid .anatomia/layers.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** `order` as declared, or undefined when the file omits it. */
function readOrder(raw: Partial<ProgramDomainConfig>): string[] | undefined {
  if (raw.order === undefined) return undefined;
  if (!Array.isArray(raw.order) || !raw.order.every((layer) => typeof layer === "string" && layer !== "")) {
    throw new Error("order must be an array of layer names");
  }
  return [...raw.order];
}

/** `allow` as declared, or undefined when the file omits it. */
function readAllow(raw: Partial<ProgramDomainConfig>): Record<string, string[]> | undefined {
  if (raw.allow === undefined) return undefined;
  if (raw.allow === null || typeof raw.allow !== "object" || Array.isArray(raw.allow)) {
    throw new Error("allow must be an object mapping a layer to the layers it may depend on");
  }
  const out: Record<string, string[]> = {};
  for (const key of Object.keys(raw.allow).sort()) {
    const targets = (raw.allow as Record<string, unknown>)[key];
    if (!Array.isArray(targets) || !targets.every((layer) => typeof layer === "string" && layer !== "")) {
      throw new Error(`allow["${key}"] must be an array of layer names`);
    }
    out[key] = [...targets];
  }
  return out;
}
