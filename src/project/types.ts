/**
 * src/project/types.ts — Multi-project support: shared types.
 *
 * SRP: type definitions only. No logic, no runtime imports.
 *
 * A Project is the registry entry describing *where* to analyze and under
 * which language/ontology settings. It is the persistable record; the analyzed
 * result (AnalysisContext) lives in the manager and is never serialized here.
 */

import type { Lang } from "../types.js";

/** A registered project = a root path + analysis settings + identity. */
export interface Project {
  /** Deterministic id: slug of `name`, or a hash of `rootPath` when no name. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Absolute path to the project root that `analyze()` walks. */
  rootPath: string;
  /** Optional language allow-list (informational; analyze() auto-detects). */
  languages?: Lang[];
  /** Optional explicit domain-ontology plugin dir for this project. */
  ontologyDir?: string;
  /**
   * Optional extra spec dirs scanned for `spec/*.md` in addition to rootPath.
   * Use when the code root is a subdir but spec lives at a sibling (e.g.
   * rootPath=`<repo>/src`, specDirs=[`<repo>/spec`]).
   */
  specDirs?: string[];
  /**
   * True when specDirs was AUTO-detected (project/spec-detect.ts) rather than
   * user-set. Auto values may be replaced by a fresh detection; user-set values
   * are never overwritten automatically.
   */
  specDirsAuto?: boolean;
  /** ISO timestamp when the project was registered. */
  addedAt: string;
}

/** Fields a caller supplies when registering a project. */
export interface ProjectInput {
  name: string;
  rootPath: string;
  /** Override the derived id (else slug(name) / hash(rootPath)). */
  id?: string;
  languages?: Lang[];
  ontologyDir?: string;
  specDirs?: string[];
}

/** The serializable shape persisted to projects.json. */
export interface RegistrySnapshot {
  version: 1;
  /** Default / selected project id, if any. */
  selected?: string | null;
  projects: Project[];
}
