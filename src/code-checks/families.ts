/**
 * @spec C++ code-level static checks
 *
 * src/code-checks/families.ts — the registry of C++ check families.
 *
 * SRP: listing the families and the rule ids they own.
 */

import { commentFamily } from "./rules/comment.js";
import { complexityFamily } from "./rules/complexity.js";
import { declarationFamily } from "./rules/declaration.js";
import { memoryFamily } from "./rules/memory.js";
import { obfuscationFamily } from "./rules/obfuscation.js";
import { placementFamily } from "./rules/placement.js";
import type { CheckFamily, Severity } from "./types.js";

export const CHECK_FAMILIES: readonly CheckFamily[] = [
  memoryFamily,
  obfuscationFamily,
  placementFamily,
  declarationFamily,
  complexityFamily,
  commentFamily,
];

/** rule id -> default severity, over every family. */
export function defaultSeverities(): ReadonlyMap<string, Severity> {
  const map = new Map<string, Severity>();
  for (const family of CHECK_FAMILIES) {
    for (const [rule, severity] of Object.entries(family.rules)) map.set(rule, severity);
  }
  return map;
}
