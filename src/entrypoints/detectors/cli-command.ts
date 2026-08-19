/**
 * src/entrypoints/detectors/cli-command.ts — CLI subcommands (`class: cli-command`).
 *
 * Three dispatch shapes, all deterministic text matches:
 *   - if-chain dispatch — `if (args.subcommand === "project") return runProject(args)`,
 *     which is exactly how `src/adapters/cli.ts` routes (the spec's first test case);
 *   - switch dispatch — `case "add": { ... runAdd(...) }`;
 *   - builder APIs — commander/yargs `.command("verb", ..., handler)`.
 *
 * SRP: CLI entry detection only.
 */

import type { EntryPointSeed } from "../types.js";
import type { Detector } from "./types.js";
import { conventionSources, isJsFamily, seedForName } from "./scan.js";

/** `... subcommand === "verb" ...` followed by the call it dispatches to. */
const IF_DISPATCH =
  /\b(?:subcommand|command|cmd|action|verb)\s*===?\s*[`'"]([\w:-]+)[`'"][\s\S]{0,120}?\b(?:return|await)\s+(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g;

/** `case "verb":` followed by the first call in the case body. */
const CASE_DISPATCH =
  /\bcase\s+[`'"]([\w:-]+)[`'"]\s*:[\s\S]{0,200}?\b(?:return|await|const\s+\w+\s*=)\s+(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g;

/** commander / yargs `.command("verb", "desc", handler)`. */
const BUILDER_COMMAND =
  /\.command\s*\(\s*[`'"]([\w:<>[\] .-]+)[`'"][^)]{0,160}?,\s*([A-Za-z_$][\w$]*)\s*[,)]/g;

export const detectCliCommand: Detector = (input) => {
  const seeds: EntryPointSeed[] = [];
  for (const [path, text] of conventionSources(input)) {
    if (!isJsFamily(path)) continue;
    for (const [pattern, shape] of [
      [IF_DISPATCH, "dispatch"],
      [CASE_DISPATCH, "case"],
      [BUILDER_COMMAND, "command()"],
    ] as const) {
      for (const match of text.matchAll(pattern)) {
        const [, verb, handler] = match;
        if (!verb || !handler) continue;
        const seed = seedForName(input, path, handler, "cli-command", "cli-command",
          `${shape} "${verb}" → ${handler}() in ${path}`);
        if (seed) seeds.push(seed);
      }
    }
  }
  return seeds;
};
