/**
 * spec/ — Code ↔ Spec linking layer (G4).
 * Re-exports from all G4 sub-modules.
 */

export { parseMdFile, parseMdText, parseSpecFiles, slugify } from "./parse.js";
export { parseOkfContent, parseOkfFile } from "../knowledge/okf-parser.js";
export { findExplicitLinks } from "./explicit.js";
export { findStructuralLinks } from "./structural.js";
export type { EmbeddingClient } from "./semantic.js";
export { findSemanticLinks } from "./semantic.js";
export { ratify, mergeLinks, hardenLoop } from "./harden.js";
export { LinkStore } from "./link-store.js";
