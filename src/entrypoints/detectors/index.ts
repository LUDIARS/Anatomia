/**
 * src/entrypoints/detectors/index.ts — The detector roster.
 *
 * Order is the spec's precedence order (config → annotation → convention). It is
 * only a reporting order: folding is by symbol and every field is sorted, so the
 * manifest does not depend on it.
 */

import { detectExplicitConfig, detectExplicitAnnotation } from "./explicit.js";
import { detectProcessMain } from "./process-main.js";
import { detectHttpRoute } from "./http-route.js";
import { detectCliCommand } from "./cli-command.js";
import { detectEventHandler } from "./event-handler.js";
import { detectScheduled } from "./scheduled.js";
import { detectFrameworkLifecycle } from "./framework-lifecycle.js";
import { detectScreen } from "./screen.js";
import type { Detector } from "./types.js";

export const DETECTORS: readonly Detector[] = [
  detectExplicitConfig,
  detectExplicitAnnotation,
  detectProcessMain,
  detectHttpRoute,
  detectCliCommand,
  detectEventHandler,
  detectScheduled,
  detectFrameworkLifecycle,
  detectScreen,
];

export type { Detector, DetectorInput, PackageManifest } from "./types.js";
export {
  detectExplicitConfig,
  detectExplicitAnnotation,
  detectProcessMain,
  detectHttpRoute,
  detectCliCommand,
  detectEventHandler,
  detectScheduled,
  detectFrameworkLifecycle,
  detectScreen,
};
