/**
 * src/entrypoints/detectors/types.ts — Detector contract.
 *
 * A detector is a pure function over already-read inputs: it never touches the
 * filesystem, so every detector is testable from a literal fixture and the whole
 * detection pass reads each source exactly once.
 *
 * SRP: contract only.
 */

import type { FileNode } from "../../types.js";
import type { ProjectProfile } from "../../project/profile.js";
import type { ScreenGraph } from "../../screens/types.js";
import type { EntryPointConfig, EntryPointSeed } from "../types.js";
import type { SymbolIndex } from "../symbols.js";

/** package.json fields that name process entry files. */
export interface PackageManifest {
  main?: string;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
}

export interface DetectorInput {
  repoPath: string;
  config: EntryPointConfig;
  symbols: SymbolIndex;
  /** Repo-relative, forward-slashed path → source text. */
  sources: Map<string, string>;
  files: FileNode[];
  projectProfile?: ProjectProfile;
  screens: ScreenGraph;
  packageManifest?: PackageManifest;
}

export type Detector = (input: DetectorInput) => EntryPointSeed[];
