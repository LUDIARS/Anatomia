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
 *
 * @spec ドメイン検出（G3）
 */

import { readdir } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { PresetId } from "./presets.js";
import type { TemplateRule } from "./template.js";
import type { NodeFilter } from "../types.js";
import { resolvePluginDir } from "../plugins/loader.js";
import { assertDomainDefinitionName } from "./assignment.js";

/** A preset configured with concrete parameters. */
export interface ConfiguredPreset {
  preset: PresetId;
  params: Record<string, unknown>;
}

/** Whether a definition owns project meaning or only evaluates policy. */
export type DomainRole = "semantic" | "policy";

/** A named domain definition (the unit a plugin contributes). */
export interface DomainDef {
  name: string;
  description: string;
  /** Missing means semantic for backwards-compatible project plugins. */
  role?: DomainRole;
  presetRules: ConfiguredPreset[];
  templateRules: TemplateRule[];
  /**
   * Declarative node OWNERSHIP, orthogonal to presetRules (which express
   * *rules* that can violate). A domain's `membership` filters contribute their
   * matched nodes to the domain's implementors WITHOUT emitting any violation —
   * so a taxonomy domain (domain-retune) can drive the Domain View even when it
   * carries zero rules. ANDed semantics within a NodeFilter, OR across the array.
   */
  membership?: NodeFilter[];
  /** Optional LLM card-summary template (T20). */
  cardTemplate?: string;
}

/** The loaded ontology = all known domain defs, keyed by name. */
export interface DomainOntology {
  domains: Map<string, DomainDef>;
}

/**
 * Repo-relative dir holding a project's COMMITTED DomainDefs — the artifact the
 * retune `register` step writes (retune/register.ts re-exports this as
 * ONTOLOGY_DIR_REL). `analyze()` falls back to it when no operator plugin dir
 * is configured, so the loader owns the constant and the writer/reader sides
 * cannot drift to different paths.
 */
export const COMMITTED_ONTOLOGY_DIR_REL = "spec/data/ontology";

// ── Builtin domains ───────────────────────────────────────────────────────

/**
 * Two example builtin policies (never implicit semantic project domains):
 *   - transition-guard-example: state nodes only mutated via transition
 *     functions; no cycles among states beyond declared transitions.
 *   - hot-path-processor: hot functions must not allocate and keep low coupling.
 */
export const BUILTIN_DOMAINS: DomainDef[] = [
  {
    name: "transition-guard-example",
    role: "policy",
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
        id: "no-direct-mutate",
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
    role: "policy",
    description:
      "Per-frame hot functions (tagged `hotPath`): no allocation in the hot path.",
    presetRules: [
      { preset: "hotPathNoAlloc", params: { hotPathTag: "hotPath", allocTag: "alloc" } },
      // NOTE: a blanket couplingCap(".*", maxFanOut:8) used to live here, but
      // matching every function made it a generic fan-out linter, not a hot-path
      // rule — it flagged ~100 unrelated functions per real repo as "violations"
      // (KS: 97). Coupling caps belong on a tagged hot-path set (once tagging
      // exists), not on ".*"; until then this domain is just the no-alloc rule.
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
  if (d.membership !== undefined && !Array.isArray(d.membership)) return false;
  if (d.role !== undefined && d.role !== "semantic" && d.role !== "policy") return false;
  return (
    typeof d.name === "string" &&
    typeof d.description === "string" &&
    Array.isArray(d.presetRules) &&
    Array.isArray(d.templateRules)
  );
}

function requireDomainDef(x: unknown, source: string): DomainDef {
  if (!isDomainDef(x)) throw new Error(`invalid DomainDef in ${source}`);
  assertDomainDefinitionName(x.name);
  return x;
}

/**
 * Load all DomainDefs from a directory (.json and .mjs files).
 *
 * `dataOnly` skips the executable (.mjs/.js) defs: an .mjs def is `import()`ed,
 * i.e. it runs arbitrary code in the analyzer's process. That is acceptable for
 * an operator-chosen dir (ANATOMIA_PLUGIN_DIR / the local `.anatomia/domains`),
 * but NOT for a dir whose contents come from the repo under analysis — an
 * ephemeral pr-review worktree holds unreviewed, author-controlled files.
 *
 * `skipInvalid` makes one unparseable/invalid file lose only that file instead
 * of the whole ontology. An operator-chosen dir stays strict (a typo there is
 * a configuration error worth surfacing), but an AUTO-DISCOVERED dir is not
 * curated for this purpose: a single stray `.json` next to the DomainDefs must
 * not silently collapse detection to zero domains — the exact "no target
 * domain" failure the committed-ontology fallback exists to prevent.
 */
async function loadFromDir(
  dir: string,
  dataOnly = false,
  skipInvalid = false,
): Promise<DomainDef[]> {
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
    const fileDefs: DomainDef[] = [];
    try {
      if (ext === ".json") {
        const { readFile } = await import("node:fs/promises");
        const raw = await readFile(full, "utf8");
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const d of list) {
          fileDefs.push(requireDomainDef(d, full));
        }
      } else if (!dataOnly && (ext === ".mjs" || ext === ".js")) {
        const mod = await import(pathToFileURL(full).href);
        const exported = mod.default ?? mod.domain ?? mod.domains;
        const list = Array.isArray(exported) ? exported : [exported];
        for (const d of list) {
          fileDefs.push(requireDomainDef(d, `export ${full}`));
        }
      }
    } catch (err) {
      if (!skipInvalid) throw err;
      continue; // drop this file only; the rest of the dir still loads
    }
    defs.push(...fileDefs);
  }
  return defs;
}

/** Options for {@link loadOntology}. */
export interface LoadOntologyOptions {
  /**
   * Load only declarative (.json) defs, ignoring executable .mjs/.js ones. Set
   * it whenever the dir's contents come from the analyzed repo rather than from
   * the operator — see loadFromDir.
   */
  dataOnly?: boolean;
  /**
   * Drop individual files that fail to parse/validate instead of failing the
   * whole load. Set it for an auto-discovered dir, where one stray `.json`
   * must not cost the caller every domain — see loadFromDir.
   */
  skipInvalid?: boolean;
}

/**
 * Load the domain ontology: builtins + plugin dir defs.
 *
 * @param pluginDir explicit dir; if omitted, ANATOMIA_PLUGIN_DIR is used.
 *                  Plugin defs override builtins of the same name.
 * @param options   `dataOnly` restricts the dir to declarative .json defs;
 *                  `skipInvalid` drops unloadable files instead of throwing.
 */
export async function loadOntology(
  pluginDir?: string,
  options: LoadOntologyOptions = {},
): Promise<DomainOntology> {
  const domains = new Map<string, DomainDef>();
  for (const d of BUILTIN_DOMAINS) {
    assertDomainDefinitionName(d.name);
    domains.set(d.name, d);
  }

  const dir = pluginDir ? resolve(pluginDir) : resolvePluginDir();
  if (dir) {
    const pluginDefs = await loadFromDir(
      dir,
      options.dataOnly === true,
      options.skipInvalid === true,
    );
    for (const d of pluginDefs) domains.set(d.name, d); // override by name
  }
  return { domains };
}
