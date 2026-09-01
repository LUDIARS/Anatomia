/**
 * T18 — Domain-ontology plugin loader.
 *
 * A domain ontology is a set of DomainDefs. Each def names a domain and
 * carries its preset configurations + template rules (+ optional card template).
 * Defs are loaded from the .json / .mjs files in the plugin directory
 * (ANATOMIA_PLUGIN_DIR or an explicit dir), plus whichever BUILTIN_DOMAINS the
 * caller/repo opted into — builtins are examples, never applied by default.
 *
 * SRP: this file ONLY loads + validates domain defs into a DomainOntology;
 * compiling defs to predicates is detect.ts's job (T19).
 *
 * Reuses plugins/loader.ts (resolvePluginDir) for the env-var convention.
 *
 * @spec ドメイン検出（G3）
 */

import { lstatSync, realpathSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
 * Repo-relative dir holding a project's COMMITTED DomainDefs — the single
 * source of truth for domain membership, sitting directly under the repo's
 * spec root so the definitions live beside the specs they attribute code to.
 * `analyze()` falls back to it when no operator plugin dir is configured, and
 * retune/register.ts re-exports it as ONTOLOGY_DIR_REL, so the loader owns the
 * constant and the writer/reader sides cannot drift to different paths.
 */
export const COMMITTED_ONTOLOGY_DIR_REL = "spec/domains";

/**
 * Pre-`spec/domains` locations still read (in order) when the source-of-truth
 * dir is absent, so repos migrate one PR at a time instead of all losing their
 * domains at once:
 *   - `spec/data/ontology` — the retune ontology artifact. It is a DERIVED,
 *     deliberately non-updating snapshot, so it is a compatibility input only,
 *     never the source of truth.
 *   - `.anatomia/domains` — the old repo-local editable dir. Local state that a
 *     Revisor review worktree may or may not carry, which is exactly why the
 *     source of truth had to move under `spec/`.
 */
export const LEGACY_ONTOLOGY_DIR_RELS: readonly string[] = [
  "spec/data/ontology",
  ".anatomia/domains",
];

/**
 * The committed DomainDef dir to load for `repoPath`, or null when the repo
 * commits none. Resolution is source-of-truth first, then each legacy location
 * in order — one place owns the migration order so `analyze()` and the PR-review
 * adapter can never disagree about which dir a repo's domains come from.
 */
export function resolveCommittedOntologyDir(repoPath: string): string | null {
  const realRepoPath = realpathSync(repoPath);
  for (const rel of [COMMITTED_ONTOLOGY_DIR_REL, ...LEGACY_ONTOLOGY_DIR_RELS]) {
    const dir = join(repoPath, rel);
    try {
      // Auto-discovered repository input must be a real directory. In
      // particular, do not follow a symlink/junction outside the checkout or
      // let a same-named regular file mask a valid legacy fallback.
      if (!lstatSync(dir).isDirectory()) continue;
      const relativeRealPath = relative(realRepoPath, realpathSync(dir));
      const isInsideRepo = relativeRealPath !== ""
        && relativeRealPath !== ".."
        && !relativeRealPath.startsWith(`..${sep}`)
        && !isAbsolute(relativeRealPath);
      if (isInsideRepo) return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}

// ── Builtin domains ───────────────────────────────────────────────────────

/**
 * Two EXAMPLE builtin policies (never implicit semantic project domains):
 *   - transition-guard-example: state nodes only mutated via transition
 *     functions; no cycles among states beyond declared transitions.
 *   - hot-path-processor: hot functions must not allocate and keep low coupling.
 *
 * They are OPT-IN — see {@link resolveBuiltinSelection}. Both are illustrations
 * of what a DomainDef can express, not rules every repo agreed to: applying
 * them by default made `transition-guard-example`'s `State$` pattern treat any
 * function whose name ends in "State" (readState, useDelegationState, …) as a
 * state-machine node, which failed the Revisor merge gate at severity=error in
 * repos that never opted into a state-machine policy at all.
 */
export const BUILTIN_DOMAINS: DomainDef[] = [
  {
    name: "transition-guard-example",
    role: "policy",
    description:
      "State held behind transition functions; state mutation only via *Transition/*Apply; no forbidden direct mutation.",
    presetRules: [
      // NOTE: a stateAccessPath(statePattern:"State$") preset used to live here,
      // but stateAccessPath's `to` filter matches by FUNCTION NAME (byName in
      // presets.ts), not by whether a node is actual state data. Any function
      // ending in "State" — e.g. a transition function itself like
      // `updateState` — matched as a false-positive "state node access"
      // violation with severity=error, blocking Revisor's merge gate on
      // ordinary code. stateAccessPath needs a real state-node marker (a tag,
      // not a name suffix) before it can be reintroduced; until then this
      // domain keeps only the cycle check.
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

// ── Builtin selection (opt-in) ───────────────────────────────────────────────

/**
 * Which builtin policies an ontology applies: an explicit list of names, every
 * builtin (`"all"`), or none (`"none"`, the default).
 */
export type BuiltinSelection = readonly string[] | "all" | "none";

/** Nothing is applied unless a repo/operator asks for it. */
export const DEFAULT_BUILTIN_SELECTION: BuiltinSelection = "none";

/**
 * Filename inside an ontology dir declaring that dir's builtin selection:
 * `{ "enabled": ["transition-guard-example"] }`, or `{ "enabled": "all" }`.
 *
 * It sits next to the DomainDefs because the selection IS part of the ontology
 * the repo commits — a Revisor review worktree holds no local state, so the
 * committed `spec/domains` is the only place a repo can state its choice
 * and have the PR gate honour it.
 */
export const BUILTIN_SELECTION_FILE = "builtins.json";

/** Env var letting an operator override the selection for one run. */
const BUILTIN_SELECTION_ENV = "ANATOMIA_BUILTIN_DOMAINS";

/** Parse `all` / `none` / `a,b` into a selection; null when unset or blank. */
function parseBuiltinSelection(raw: string | undefined): BuiltinSelection | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed === "all" || trimmed === "none") return trimmed;
  const names = trimmed.split(",").map((n) => n.trim()).filter((n) => n.length > 0);
  return names.length > 0 ? names : "none";
}

/** Read `<dir>/builtins.json`. Missing file → null; malformed shape → throw. */
async function readBuiltinSelectionFile(dir: string): Promise<BuiltinSelection | null> {
  const file = join(dir, BUILTIN_SELECTION_FILE);
  let stat: import("node:fs").Stats;
  try {
    stat = await lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`unable to inspect ${BUILTIN_SELECTION_FILE}`, { cause: err });
  }
  if (!stat.isFile()) {
    throw new Error(`${BUILTIN_SELECTION_FILE} must be a regular file`);
  }
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`unable to read ${BUILTIN_SELECTION_FILE}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // V8 may quote part of the input in SyntaxError.message. The reason is
    // logged for auto-discovered files, so do not copy repository contents to
    // diagnostic output.
    throw new Error(`invalid JSON in ${BUILTIN_SELECTION_FILE}`);
  }
  const enabled = (parsed as { enabled?: unknown } | null)?.enabled;
  if (enabled === "all" || enabled === "none") return enabled;
  if (Array.isArray(enabled) && enabled.every((n) => typeof n === "string")) {
    return enabled as string[];
  }
  throw new Error(
    `invalid ${BUILTIN_SELECTION_FILE}: "enabled" must be "all", "none", or a string[]`,
  );
}

/**
 * The builtins a selection turns on.
 *
 * Unknown names are IGNORED rather than rejected: the builtin set changes
 * between Anatomia versions, and a repo that pins a name this build no longer
 * ships must still analyze — losing one example policy is recoverable, failing
 * the whole ontology load (and with it every semantic domain) is not.
 */
export function resolveBuiltinSelection(selection: BuiltinSelection): DomainDef[] {
  if (selection === "none") return [];
  if (selection === "all") return [...BUILTIN_DOMAINS];
  const wanted = new Set(selection);
  return BUILTIN_DOMAINS.filter((d) => wanted.has(d.name));
}

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

/** One ontology file `skipInvalid` dropped, and why it was dropped. */
export interface OntologySkip {
  /** Absolute path of the definition or builtin-selection file that was not loaded. */
  file: string;
  /** Human-readable cause (parse error, validation error, not a regular file…). */
  reason: string;
}

/** Callback notified for every ontology file `skipInvalid` drops. */
export type OntologySkipListener = (skip: OntologySkip) => void;

/** Render an unknown throw value as the `reason` of an {@link OntologySkip}. */
function skipReason(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause;
    if (cause instanceof Error && cause.message !== "") {
      return `${err.message}: ${cause.message}`;
    }
    if (err.message !== "") return err.message;
  }
  return String(err);
}

/** Escape control characters so repository-controlled paths cannot forge log lines. */
function formatOntologySkipField(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Default {@link OntologySkipListener}: warn on stderr.
 *
 * A dropped definition and a definition nobody wrote look identical downstream
 * ("target domain is still missing"), so `skipInvalid` must never be silent —
 * RULE_CODE §7 / §7.1 (no silent fallback, no failure reported as success).
 */
export function warnOntologySkip(skip: OntologySkip): void {
  const file = formatOntologySkipField(skip.file);
  const reason = formatOntologySkipField(skip.reason);
  console.warn(`[anatomia] ontology definition skipped: ${file}: ${reason}`);
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
 * domain" failure the committed-ontology fallback exists to prevent. Every file
 * it drops is reported to `onSkip` (default: {@link warnOntologySkip}) so the
 * loss is visible instead of being mistaken for a missing declaration.
 */
async function loadFromDir(
  dir: string,
  dataOnly = false,
  skipInvalid = false,
  onSkip: OntologySkipListener = warnOntologySkip,
): Promise<DomainDef[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error("unable to read ontology directory", { cause: err });
  }
  const defs: DomainDef[] = [];
  for (const entry of entries) {
    // The builtin selection lives in this dir but is not a DomainDef; reading
    // it as one would fail validation (and, in a strict operator dir, take the
    // whole ontology down).
    if (entry.name === BUILTIN_SELECTION_FILE) continue;
    const ext = extname(entry.name).toLowerCase();
    if (ext !== ".json" && ext !== ".mjs" && ext !== ".js") continue;
    const full = join(dir, entry.name);
    let stat: import("node:fs").Stats;
    try {
      stat = await lstat(full);
    } catch (err) {
      if (skipInvalid) {
        onSkip({ file: full, reason: skipReason(err) });
        continue;
      }
      throw new Error("unable to inspect ontology definition", { cause: err });
    }
    if (!stat.isFile()) {
      if (skipInvalid) {
        onSkip({ file: full, reason: "ontology definitions must be regular files" });
        continue;
      }
      throw new Error("ontology definitions must be regular files");
    }
    const fileDefs: DomainDef[] = [];
    try {
      if (ext === ".json") {
        const raw = await readFile(full, "utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // Keep the warning useful without echoing a potentially sensitive
          // fragment of the invalid repository file from SyntaxError.message.
          throw new Error("invalid ontology definition JSON");
        }
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
      // Drop this file only; the rest of the dir still loads — but say so.
      onSkip({ file: full, reason: skipReason(err) });
      continue;
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
   * Drop individual definitions (including malformed `builtins.json`) that
   * fail to parse/validate instead of failing the whole load. Set it for an
   * auto-discovered dir, where one stray `.json` must not cost the caller every
   * domain — see loadFromDir.
   */
  skipInvalid?: boolean;
  /**
   * Notified once per ontology file `skipInvalid` drops, including a malformed
   * builtin-selection file, with the file and the reason.
   * Defaults to {@link warnOntologySkip} — a dropped definition is never lost
   * silently, so callers can tell "the declaration is broken" from "nobody
   * declared it".
   */
  onSkip?: OntologySkipListener;
  /**
   * Which builtin policies to apply. Highest-precedence source; when omitted
   * the selection falls back to $ANATOMIA_BUILTIN_DOMAINS, then to the ontology
   * dir's `builtins.json`, then to {@link DEFAULT_BUILTIN_SELECTION}.
   */
  builtins?: BuiltinSelection;
}

/**
 * Resolve the builtin selection for a load: explicit option > env override >
 * the ontology dir's committed declaration > the default (none). A malformed
 * declaration is ignored only for tolerant auto-discovered repository input.
 */
async function resolveSelection(
  dir: string | null,
  option: BuiltinSelection | undefined,
  skipInvalid = false,
  onSkip: OntologySkipListener = warnOntologySkip,
): Promise<BuiltinSelection> {
  if (option !== undefined) return option;
  const fromEnv = parseBuiltinSelection(process.env[BUILTIN_SELECTION_ENV]);
  if (fromEnv !== null) return fromEnv;
  if (dir) {
    try {
      const fromFile = await readBuiltinSelectionFile(dir);
      if (fromFile !== null) return fromFile;
    } catch (error) {
      if (!skipInvalid) throw error;
      onSkip({ file: join(dir, BUILTIN_SELECTION_FILE), reason: skipReason(error) });
    }
  }
  return DEFAULT_BUILTIN_SELECTION;
}

/**
 * Load the domain ontology: builtins + plugin dir defs.
 *
 * Builtins are opt-in and default to none, so an ontology contains exactly the
 * domains its repo declared — see {@link resolveBuiltinSelection}.
 *
 * @param pluginDir explicit dir; if omitted, ANATOMIA_PLUGIN_DIR is used.
 *                  Plugin defs override builtins of the same name.
 * @param options   `dataOnly` restricts the dir to declarative .json defs;
 *                  `skipInvalid` drops unloadable files instead of throwing,
 *                  reporting each one to `onSkip` (default: a stderr warning);
 *                  `builtins` overrides the builtin selection.
 */
export async function loadOntology(
  pluginDir?: string,
  options: LoadOntologyOptions = {},
): Promise<DomainOntology> {
  const domains = new Map<string, DomainDef>();
  const dir = pluginDir ? resolve(pluginDir) : resolvePluginDir();
  const onSkip = options.onSkip ?? warnOntologySkip;

  const selection = await resolveSelection(
    dir,
    options.builtins,
    options.skipInvalid === true,
    onSkip,
  );
  for (const d of resolveBuiltinSelection(selection)) {
    assertDomainDefinitionName(d.name);
    domains.set(d.name, d);
  }

  if (dir) {
    const pluginDefs = await loadFromDir(
      dir,
      options.dataOnly === true,
      options.skipInvalid === true,
      onSkip,
    );
    for (const d of pluginDefs) domains.set(d.name, d); // override by name
  }
  return { domains };
}
