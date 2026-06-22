/**
 * src/modules/types.ts — The 機能(module) layer: types.
 *
 * Between a FUNCTION (構造グラフ) and a DOMAIN (semantic) sits a MODULE/機能 — a
 * structural cohesion unit (a directory, or a class). Domains may span modules;
 * modules belong to domains. Module boundaries are DETERMINISTIC structural units
 * (directory by default, class via enclosingType) so they match the panel's
 * existing vis-data grouping and stay cache-safe. The aggregation's QUALITY is
 * then *evaluated* (cohesion / coupling / misfit / modularity) — but modules are
 * not auto-reclustered; a low score is surfaced as a signal, not silently fixed.
 *
 * SRP: type definitions only.
 */

import type { AnchorId } from "../types.js";

/** How functions are grouped into a module. */
export type ModuleGranularity = "dir" | "class";

/** A structural cohesion unit (機能). */
export interface ModuleUnit {
  /** Stable id: the directory path (fwd slashes), or `<file>::<Class>`. */
  id: string;
  kind: ModuleGranularity;
  /** Short display label (last path segment, or class name). */
  label: string;
  /** Member function anchors (sorted). */
  anchors: AnchorId[];
  /** Files the members live in (sorted, de-duplicated). */
  files: string[];
}

/** Cohesion/coupling evaluation of one module. */
export interface ModuleCohesion {
  moduleId: string;
  /** #edges with both endpoints inside the module. */
  internalEdges: number;
  /** #edges leaving the module (member → outside). */
  outgoingExternal: number;
  /** #edges entering the module (outside → member). */
  incomingExternal: number;
  /** internal / (internal + outgoingExternal); 1 when the module has no edges. */
  cohesion: number;
  /** #member anchors. */
  size: number;
}

/** A function that couples more strongly to another module than its own. */
export interface MisfitFunction {
  anchor: AnchorId;
  name: string;
  /** The module the function currently lives in. */
  homeModule: string;
  /** The module it ties to most strongly (more than home). */
  attractedTo: string;
  /** #ties (calls/reads/writes, both directions) to the home module. */
  homeTies: number;
  /** #ties to the attracting module. */
  attractedTies: number;
}

/** Whole-partition evaluation of the function→module aggregation. */
export interface ModuleEvaluation {
  granularity: ModuleGranularity;
  modules: ModuleUnit[];
  cohesion: ModuleCohesion[];
  misfits: MisfitFunction[];
  /** Newman-style modularity of the partition (−0.5..1; higher = better split). */
  modularity: number;
}
