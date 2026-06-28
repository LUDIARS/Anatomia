/**
 * src/domains/cache.ts — content-addressed cache key for domain detection.
 *
 * detectDomains (detect.ts) is O(domains × functions) and runs in analyze()
 * Phase 4 on every fingerprint MISS. The project fingerprint (project/cache.ts)
 * already short-circuits the all-unchanged case (analyze() is skipped whole);
 * but a fingerprint miss that does NOT change the code — editing a spec/ or a
 * config file, which the fingerprint folds in — still re-pays full detection
 * even though the DAG (hence the detection result) is identical. Keying the
 * result by code identity + ontology lets that path reuse the prior result.
 *
 * Key = versionedKey(dagContentKey(files), hashOntology(ontology), VERSION).
 *   dagContentKey folds each file's PATH and structural Merkle hash — so a
 *   content edit OR a rename (path-pattern domain rules depend on paths) busts
 *   it. hashOntology folds the domain defs — so an ontology/plugin edit busts it.
 *
 * SRP: key derivation only. The store + lookup live at the call site (core.ts).
 */

import { createHash } from "node:crypto";
import { versionedKey } from "../cache/store.js";
import type { DomainOntology } from "./ontology.js";
import type { FileNode } from "../types.js";

/** BUMP when detectDomains' inputs/semantics change (shared-store correctness). */
export const DETECTION_CACHE_VERSION = "1";

/** Hash the ontology's domain defs so an ontology edit busts the detection cache. */
export function hashOntology(ontology: DomainOntology): string {
  const entries = [...ontology.domains.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, def]) => `${name}\0${JSON.stringify(def)}`);
  return createHash("sha256").update(entries.join("\n"), "utf8").digest("hex");
}

/** Code identity for detection: each file's path + structural Merkle hash. */
function dagContentKey(files: FileNode[]): string {
  const stamps = files
    .map((f) => `${f.path.replace(/\\/g, "/")}\0${f.hash ?? ""}`)
    .sort();
  return createHash("sha256").update(stamps.join("\n"), "utf8").digest("hex");
}

/** Cache key for a detectDomains result over `files` with `ontology`. */
export function detectionCacheKey(files: FileNode[], ontology: DomainOntology): string {
  return versionedKey(dagContentKey(files), hashOntology(ontology), DETECTION_CACHE_VERSION);
}
