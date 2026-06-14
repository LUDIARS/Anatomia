/**
 * Plugin directory resolver (T01 scaffold stub).
 *
 * Reads ANATOMIA_PLUGIN_DIR from the environment and returns the resolved
 * absolute path.  Actual plugin loading (T18) will import mechanic-ontology
 * packages from this directory at runtime.
 *
 * SRP: this file only resolves the directory — no loading logic here.
 */

import { resolve } from "node:path";

/**
 * Returns the plugin directory path from the environment, or null when the
 * variable is unset.  Callers must handle the null case gracefully.
 */
export function resolvePluginDir(): string | null {
  const raw = process.env["ANATOMIA_PLUGIN_DIR"];
  if (!raw) return null;
  return resolve(raw);
}
