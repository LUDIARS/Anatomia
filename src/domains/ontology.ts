/**
 * T18 — Domain-ontology plugin loader.
 *
 * A domain ontology is a set of DomainDefs. Each def names a domain and
 * carries its preset configurations + template rules (+ optional card template).
 * Defs are loaded from BUILTIN_DOMAINS plus any .json / .mjs files in the
 * plugin directory (ANATOMIA_PLUGIN_DIR or an explicit dir).
 *
 * SRP: this file ONLY loads + validates domain defs into a DomainOntology;
 * compiling defs to predicates is detect.ts's job (T19).
 *
 * Reuses plugins/loader.ts (resolvePluginDir) for the env-var convention.
 */

import { readdir } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { PresetId } from "./presets.js";
import type { TemplateRule } from "./template.js";
import { resolvePluginDir } from "../plugins/loader.js";

/** A preset configured with concrete parameters. */
export interface ConfiguredPreset {
  preset: PresetId;
  params: Record<string, unknown>;
}

/** A named domain definition (the unit a plugin contributes). */
export interface DomainDef {
  name: string;
  description: string;
  presetRules: ConfiguredPreset[];
  templateRules: TemplateRule[];
  /** Optional LLM card-summary template (T20). */
  cardTemplate?: string;
}

/** The loaded ontology = all known domain defs, keyed by name. */
export interface DomainOntology {
  domains: Map<string, DomainDef>;
}

// ── Builtin domains ───────────────────────────────────────────────────────

/**
 * Two example builtin domains:
 *   - state-machine: state nodes only mutated via transition functions; no
 *     cycles among states beyond declared transitions.
 *   - hot-path-processor: hot functions must not allocate and keep low coupling.
 */
export const BUILTIN_DOMAINS: DomainDef[] = [
  {
    name: "state-machine",
    description:
      "State held behind transition functions; state mutation only via *Transition/*Apply; no forbidden direct mutation.",
    presetRules: [
      {
        preset: "stateAccessPath",
        params: { statePattern: "State$", allowedCallerPattern: "Transition|Apply|Reduce" },
      },
      { preset: "noCycle", params: { scopePattern: "Transition$" } },
    ],
    templateRules: [
      {
        id: "state-machine/no-direct-mutate",
        pattern: "$SKILL.mutate($STATE)",
        metavars: ["SKILL", "STATE"],
        language: "cpp",
        positive: false,
        description: "Forbid direct state mutation via .mutate(); go through a transition.",
      },
    ],
    cardTemplate:
      "Summarise this state machine: its states, the transition functions, and how mutation is gated.",
  },
  {
    name: "hot-path-processor",
    description:
      "Per-frame hot functions: no allocation, low fan-out, tight coupling budget.",
    presetRules: [
      { preset: "hotPathNoAlloc", params: { hotPathTag: "hotPath", allocTag: "alloc" } },
      { preset: "couplingCap", params: { targetPattern: ".*", maxFanOut: 8 } },
    ],
    templateRules: [],
    cardTemplate:
      "Summarise this hot-path processor: the per-frame entry points, what they touch, and any allocation risk.",
  },
];

// ── Loading ─────────────────────────────────────────────────────────────────

/** Minimal structural validation of a loaded def. */
function isDomainDef(x: unknown): x is DomainDef {
  if (!x || typeof x !== "object") return false;
  const d = x as Record<string, unknown>;
  return (
    typeof d.name === "string" &&
    typeof d.description === "string" &&
    Array.isArray(d.presetRules) &&
    Array.isArray(d.templateRules)
  );
}

/** Load all DomainDefs from a directory (.json and .mjs files). */
async function loadFromDir(dir: string): Promise<DomainDef[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return []; // missing dir = no plugins
  }
  const defs: DomainDef[] = [];
  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    const full = join(dir, entry);
    if (ext === ".json") {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(full, "utf8");
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const d of list) {
        if (isDomainDef(d)) defs.push(d);
        else throw new Error(`invalid DomainDef in ${full}`);
      }
    } else if (ext === ".mjs" || ext === ".js") {
      const mod = await import(pathToFileURL(full).href);
      const exported = mod.default ?? mod.domain ?? mod.domains;
      const list = Array.isArray(exported) ? exported : [exported];
      for (const d of list) {
        if (isDomainDef(d)) defs.push(d);
        else throw new Error(`invalid DomainDef export in ${full}`);
      }
    }
  }
  return defs;
}

/**
 * Load the domain ontology: builtins + plugin dir defs.
 *
 * @param pluginDir explicit dir; if omitted, ANATOMIA_PLUGIN_DIR is used.
 *                  Plugin defs override builtins of the same name.
 */
export async function loadOntology(pluginDir?: string): Promise<DomainOntology> {
  const domains = new Map<string, DomainDef>();
  for (const d of BUILTIN_DOMAINS) domains.set(d.name, d);

  const dir = pluginDir ? resolve(pluginDir) : resolvePluginDir();
  if (dir) {
    const pluginDefs = await loadFromDir(dir);
    for (const d of pluginDefs) domains.set(d.name, d); // override by name
  }
  return { domains };
}
