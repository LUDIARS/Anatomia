/**
 * src/supply/plan/ux-critical-bridge.ts — From UX-critical BUSINESS domains to
 * the detection-taxonomy names `plan` and `test-suggestions` speak (A-10).
 *
 * The business taxonomy (knowledge log, human-approved) and the detection
 * taxonomy (`spec/domains`, deterministic) are different namespaces. A domain
 * called `kirie-transform` in one is not necessarily the same thing in the
 * other, so this bridge never matches on the name: it goes through the approved
 * `domain-owns-code` edges and asks which detection domains claim the same code
 * symbols. A business domain whose code nobody detects simply yields nothing,
 * rather than lending its `uxCritical` mark to a same-named stranger.
 *
 * A repository with no knowledge log yields an empty list — no marks, no guess.
 *
 * SRP: resolution only. The derivation is knowledge/domain/ux-critical.ts; what
 * the mark DOES is plan/build.ts and the test-suggestions route.
 *
 * @spec UX 直結ドメインの plan / test-suggestions への引き継ぎ (A-10)
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { replayKnowledgeLog } from "../../knowledge/log.js";
import {
  deriveUxCriticalDomains,
  resolveUxCriticalDetectionDomains,
  uxCriticalDomainIds,
  type UxCriticalSurface,
} from "../../knowledge/domain/ux-critical.js";

/** Where a project's canonical knowledge log lives. */
export function knowledgeLogPathFor(
  repoPath: string,
  projectId: string,
  knowledgeWriteRoot = join(repoPath, "spec"),
): string {
  return join(knowledgeWriteRoot, "data", "domain-map", `${projectId}.knowledge.jsonl`);
}

/**
 * Whether the repository has a canonical knowledge log at all.
 *
 * Callers use it to skip the whole UX-critical resolution (and the analysis it
 * needs) for a repository where nothing can be approved yet.
 */
export async function hasKnowledgeLog(
  repoPath: string,
  projectId: string,
  knowledgeWriteRoot?: string,
): Promise<boolean> {
  try { await access(knowledgeLogPathFor(repoPath, projectId, knowledgeWriteRoot)); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Inputs for {@link resolveUxCriticalDomainNames}. */
export interface UxCriticalBridgeInput {
  repoPath: string;
  projectId: string;
  /** Registered canonical write root. Omitted only for conventional `<repo>/spec`. */
  knowledgeWriteRoot?: string | undefined;
  /** Detection results — `AnalysisContext.domains` shaped down to what is needed. */
  detections: readonly { domain: string; implementors: readonly string[] }[];
  /** Screen/scene surface used for the derivation. Empty when none is known. */
  surface?: UxCriticalSurface;
}

/**
 * Detection-taxonomy domain names that are UX-critical in this repository.
 *
 * Returns an empty array when the repository has no knowledge log: nothing is
 * approved there, so nothing can be UX-critical by evidence, and an explicit
 * declaration lives in that same log.
 */
export async function resolveUxCriticalDomainNames(
  input: UxCriticalBridgeInput,
): Promise<string[]> {
  const log = await readLog(knowledgeLogPathFor(input.repoPath, input.projectId, input.knowledgeWriteRoot));
  if (log === null) return [];
  const state = replayKnowledgeLog(log);
  const findings = deriveUxCriticalDomains(
    state,
    input.surface ?? { entryCodeSymbolIds: [], screenFiles: [] },
  );
  return resolveUxCriticalDetectionDomains(state, uxCriticalDomainIds(findings), input.detections);
}

async function readLog(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
