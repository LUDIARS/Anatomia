/**
 * src/screens/index.ts — Public surface of the screen-composition layer.
 *
 * SRP: re-export only. The detection lives in detect.ts, the types in types.ts.
 */

export { detectScreens, scanForScreens } from "./detect.js";
export type { ScanFile } from "./detect.js";
export type { ScreenGraph, ScreenNode, ScreenKind, ScreenStack } from "./types.js";
