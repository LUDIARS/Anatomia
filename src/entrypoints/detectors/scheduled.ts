/**
 * src/entrypoints/detectors/scheduled.ts — Timer entries (`class: scheduled`).
 *
 * A timer callback is an entry for the same reason an event handler is: the
 * clock calls it, nothing in the repo does. Covers `setInterval` / `setTimeout`
 * with a named callback and the `cron.schedule(expr, handler)` family.
 *
 * SRP: scheduled entry detection only.
 */

import type { EntryPointSeed } from "../types.js";
import type { Detector } from "./types.js";
import { conventionSources, isJsFamily, seedForName } from "./scan.js";

/** `setInterval(tick, 1000)` / `setTimeout(boot, 0)`. */
const TIMER = /\b(setInterval|setTimeout)\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
/** `cron.schedule("* * * * *", handler)` / `schedule.scheduleJob(expr, handler)`. */
const CRON =
  /\b(?:cron\s*\.\s*schedule|scheduleJob|schedule)\s*\(\s*[`'"][^`'"]+[`'"]\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g;

export const detectScheduled: Detector = (input) => {
  const seeds: EntryPointSeed[] = [];
  for (const [path, text] of conventionSources(input)) {
    if (!isJsFamily(path)) continue;
    for (const match of text.matchAll(TIMER)) {
      const [, api, handler] = match;
      if (!handler) continue;
      const seed = seedForName(input, path, handler, "scheduled", "scheduled",
        `${api}(${handler}) in ${path}`);
      if (seed) seeds.push(seed);
    }
    for (const match of text.matchAll(CRON)) {
      const handler = match[1];
      if (!handler) continue;
      const seed = seedForName(input, path, handler, "scheduled", "scheduled",
        `cron schedule → ${handler}() in ${path}`);
      if (seed) seeds.push(seed);
    }
  }
  return seeds;
};
