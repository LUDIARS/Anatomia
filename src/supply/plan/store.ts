/**
 * src/supply/plan/store.ts — Persist / locate a plan under `.anatomia/plan/`.
 *
 * The plan file is the RECONCILIATION MATERIAL for review (design §5): after the
 * work is done, `verify --plan` compares the files the diff touched against the
 * domains the task was planned into. That only works if the plan survives the
 * session that produced it, so every run writes one per repo, keyed by a hash of
 * the task + the repos it covered (the same task re-planned overwrites its own
 * file instead of accumulating near-duplicates).
 *
 * SRP: file naming, reading and writing. No plan content decisions.
 *
 * @spec パイプライン（`src/supply/plan/`）
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLAN_VERSION, type Plan, type PlanItem } from "./types.js";

/** Repo-relative dir a repo's plans are written to. */
export const PLAN_DIR_REL = ".anatomia/plan";

/** Stable id for a (task, repos) pair — the plan file's basename. */
export function planHash(task: string, repos: string[]): string {
  const h = createHash("sha256");
  h.update(task.trim(), "utf8");
  for (const repo of [...repos].sort()) h.update(`\0${repo}`, "utf8");
  return h.digest("hex").slice(0, 16);
}

/** Absolute path of a plan file inside `repoPath`. */
export function planFilePath(repoPath: string, taskHash: string): string {
  if (!/^[a-f0-9]{16}$/.test(taskHash)) {
    throw new Error(`invalid plan task hash: ${taskHash}`);
  }
  return join(repoPath, PLAN_DIR_REL, `${taskHash}.json`);
}

/**
 * Write the plan into every repo it covers, returning the paths written.
 *
 * A repo whose `.anatomia/` is not writable (a read-only checkout, a sandbox)
 * must not fail the plan — the Markdown the user asked for is already produced.
 * The failure is returned to the caller so it can be reported as a note.
 */
export async function savePlan(
  plan: Plan,
  repositories: { id: string; repoPath: string }[],
): Promise<{ written: string[]; failed: { path: string; reason: string }[] }> {
  const written: string[] = [];
  const failed: { path: string; reason: string }[] = [];
  for (const { id, repoPath } of repositories) {
    const file = planFilePath(repoPath, plan.taskHash);
    if (!plan.repos.includes(id)) {
      failed.push({ path: file, reason: `repository id "${id}" is not present in the plan` });
      continue;
    }
    try {
      await mkdir(join(repoPath, PLAN_DIR_REL), { recursive: true });
      const body = JSON.stringify({ ...plan, storedForRepo: id }, null, 2);
      await writeFile(file, body, "utf8");
      written.push(file);
    } catch (error) {
      failed.push({ path: file, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { written, failed };
}

/** Read a plan file. Throws when it is missing or not a plan. */
export async function loadPlan(file: string): Promise<Plan> {
  const raw = await readFile(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`plan file is not valid JSON: ${file}`);
  }
  if (!isPlan(parsed)) {
    throw new Error(`plan file does not match ${PLAN_VERSION}: ${file}`);
  }
  return parsed;
}

function isPlan(value: unknown): value is Plan {
  if (!isRecord(value) || value["version"] !== PLAN_VERSION) return false;
  if (
    !isString(value["task"])
    || !isString(value["taskHash"])
    || !/^[a-f0-9]{16}$/.test(value["taskHash"])
    || !isString(value["generatedAt"])
  ) {
    return false;
  }
  const repos = value["repos"];
  if (!isStringArray(repos) || !isStringArray(value["questions"]) || !isStringArray(value["notes"])) {
    return false;
  }
  const storedForRepo = value["storedForRepo"];
  if (
    storedForRepo !== undefined
    && (!isString(storedForRepo) || !repos.includes(storedForRepo))
  ) {
    return false;
  }
  if (value["source"] !== "llm" && value["source"] !== "deterministic") return false;
  if (!Array.isArray(value["items"]) || !value["items"].every(isPlanItem)) return false;
  if (!value["items"].every((item) => repos.includes(item.repo))) return false;
  if (!Array.isArray(value["unresolved"]) || !value["unresolved"].every(isUnresolved)) return false;
  // A-11: the warnings and the item ids they reference are part of the stored
  // shape, so a plan whose warnings dangle is not a plan we can act on.
  if (!Array.isArray(value["layerWarnings"]) || !value["layerWarnings"].every(isLayerWarning)) return false;
  const itemIds = new Set(value["items"].map((item) => item.id));
  if (itemIds.size !== value["items"].length) return false;
  if (!value["items"].every((item) => item.dependsOn.every((id) => itemIds.has(id)))) return false;
  if (!value["layerWarnings"].every((warning) => itemIds.has((warning as { fromItemId: string }).fromItemId) && itemIds.has((warning as { toItemId: string }).toItemId))) return false;
  return true;
}

function isLayerWarning(value: unknown): boolean {
  return isRecord(value)
    && isString(value["fromItemId"])
    && isString(value["toItemId"])
    && isString(value["fromLayer"])
    && isString(value["toLayer"])
    && isString(value["reason"]);
}

function isPlanItem(value: unknown): value is PlanItem {
  if (!isRecord(value)) return false;
  if (!isString(value["id"]) || value["id"] === "") return false;
  if (!isStringArray(value["dependsOn"])) return false;
  if (typeof value["uxCritical"] !== "boolean") return false;
  if (
    !isString(value["repo"])
    || !isString(value["domain"])
    || !isString(value["responsibility"])
  ) {
    return false;
  }
  if (value["status"] !== "existing" && value["status"] !== "new") return false;
  if (
    !isStringArray(value["plannedPaths"])
    || !isStringArray(value["ownedPathPatterns"])
    || !isStringArray(value["neededTypes"])
  ) {
    return false;
  }
  if (value["layer"] !== null && !isString(value["layer"])) return false;
  if (!Array.isArray(value["dataDefs"]) || !value["dataDefs"].every(isDataDef)) return false;
  if (!Array.isArray(value["duplicates"]) || !value["duplicates"].every(isDuplicate)) return false;
  if (value["exemplar"] !== null && !isExemplar(value["exemplar"])) return false;
  if (value["newDomain"] !== undefined && !isNewDomain(value["newDomain"])) return false;
  return true;
}

function isDataDef(value: unknown): boolean {
  return isRecord(value)
    && (value["kind"] === "type" || value["kind"] === "function")
    && isString(value["name"])
    && isString(value["path"]);
}

function isDuplicate(value: unknown): boolean {
  return isRecord(value)
    && isString(value["name"])
    && isString(value["path"])
    && isFiniteNumber(value["score"]);
}

function isExemplar(value: unknown): boolean {
  return isRecord(value)
    && (value["anchor"] === null || isString(value["anchor"]))
    && isString(value["name"])
    && isString(value["path"])
    && (value["layer"] === null || isString(value["layer"]))
    && isFiniteNumber(value["references"]);
}

function isNewDomain(value: unknown): boolean {
  return isRecord(value)
    && isString(value["name"])
    && isString(value["description"])
    && Array.isArray(value["membership"])
    && value["membership"].every(
      (entry) => isRecord(entry) && isString(entry["pathPattern"]),
    );
}

function isUnresolved(value: unknown): boolean {
  return isRecord(value)
    && isString(value["repo"])
    && isString(value["subject"])
    && isString(value["reason"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The most recently written plan of a repo, or null when it has none.
 * Used by `verify --plan` with no argument: the plan a PR should be checked
 * against is almost always the last one made for that checkout.
 */
export async function latestPlanFile(repoPath: string): Promise<string | null> {
  const dir = join(repoPath, PLAN_DIR_REL);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const candidates: { file: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = join(dir, entry);
    try {
      candidates.push({ file, mtime: (await stat(file)).mtimeMs });
    } catch {
      // A file that vanished between readdir and stat is simply not a candidate.
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
  return candidates[0]!.file;
}
