/**
 * src/entrypoints/types.ts — Entry-point trace graph: data contract.
 *
 * Implements the shapes of spec/feature/entrypoint-trace-graph.md. An entry
 * point's stable id IS its symbol anchor: display name and path are evidence,
 * never identity, so a rename that keeps the body follows the same entry.
 *
 * SRP: type definitions only.
 */

import type { AnchorId, EdgeKind, UnresolvedReason } from "../types.js";

// The bundle-facing shape lives with ContextBundle in src/types.ts; re-exported
// here so entry-point consumers import one module.
export type { NearestEntry } from "../types.js";

/** Classification of an entry point (spec: entry class). */
export type EntryClass =
  | "process"
  | "http-route"
  | "cli-command"
  | "event-handler"
  | "scheduled"
  | "framework-lifecycle"
  | "screen"
  | "explicit";

/** Which detector produced a seed. */
export type EntryDetectorName =
  | "explicit-config"
  | "explicit-annotation"
  | "process-main"
  | "http-route"
  | "cli-command"
  | "event-handler"
  | "scheduled"
  | "framework-lifecycle"
  | "screen";

/** A single detector hit, before folding by symbol. */
export interface EntryPointSeed {
  anchor: AnchorId;
  entryClass: EntryClass;
  detector: EntryDetectorName;
  /** Why this detector fired (human-facing evidence, not identity). */
  reason: string;
  /** Framework lifecycle phase, when the detector knows one. */
  phase?: string;
}

/** The symbol an entry point is anchored to. */
export interface EntryPointSymbol {
  anchor: AnchorId;
  name: string;
  /** Repo-relative, forward-slashed. */
  path: string;
  line: number;
}

/** One folded entry point in the canonical manifest. */
export interface EntryPoint {
  /** Stable id = the symbol anchor. */
  id: string;
  classes: EntryClass[];
  detector: EntryDetectorName[];
  symbol: EntryPointSymbol;
  phase?: string;
  reasons: string[];
}

export type EntryPointDiagnosticKind = "max-depth" | "no-entry-detected" | "config-invalid";

export interface EntryPointDiagnostic {
  kind: EntryPointDiagnosticKind;
  message: string;
  /** Entry the diagnostic belongs to, when it is entry-scoped. */
  entryId?: string;
}

/** Traversal settings, resolved from config + defaults. */
export interface EntryPointTraversal {
  edgeKinds: EdgeKind[];
  maxDepth: number;
}

/** A config rule; any set field must match (AND) for the rule to apply. */
export interface EntryPointRule {
  /** `<repo-relative path>#<symbol name>`, or a bare anchor id. */
  symbol?: string;
  pathGlob?: string;
  namePattern?: string;
  class?: EntryClass;
}

/** `.anatomia/entrypoints.json`, normalized. */
export interface EntryPointConfig {
  includeTests: boolean;
  include: EntryPointRule[];
  exclude: EntryPointRule[];
  traversal: EntryPointTraversal;
}

/** The canonical entry set for one analysis (code-authoritative, replaced whole). */
export interface EntryPointManifest {
  entries: EntryPoint[];
  diagnostics: EntryPointDiagnostic[];
  config: EntryPointConfig;
}

/** A call site whose edge static resolution dropped — the traversal's frontier. */
export interface EntryPointFrontier {
  calleeName: string;
  receiverType?: string;
  reason: UnresolvedReason;
}

/** Per-entry summary row of the product graph. */
export interface EntryPointSummary {
  id: string;
  classes: EntryClass[];
  detector: EntryDetectorName[];
  symbol: EntryPointSymbol;
  phase?: string;
  /** Symbols reached from this entry (including the entry itself). */
  reached: number;
  maxDistance: number;
  activatesDomains: { business: string[]; program: string[] };
  frontierCount: number;
}

/** One CodeSymbol in the product graph, with its per-entry reach facts. */
export interface EntryPointNode {
  anchor: string;
  name: string;
  path: string;
  reachedFrom: string[];
  distance: Record<string, number>;
  via: Record<string, string>;
  owner?: string;
  programDomain?: string;
  frontier: EntryPointFrontier[];
}

/** A traversal-tree edge (product graph edges are tree edges only). */
export interface EntryPointEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  onTreeOf: string[];
}

/** A CodeSymbol no entry reaches — surfaced, never silently folded into an entry. */
export interface UnrootedSymbol {
  anchor: string;
  name: string;
  path: string;
}

/** The persisted artifact: `<generated>/entrypoint-graph.json`. */
export interface EntryPointGraph {
  schemaVersion: 1;
  projectId: string;
  sourceRevision: string;
  definitionFingerprint: string;
  entries: EntryPointSummary[];
  nodes: EntryPointNode[];
  edges: EntryPointEdge[];
  unrooted: UnrootedSymbol[];
  diagnostics: EntryPointDiagnostic[];
}

/** Domain colouring, read from the knowledge layer and never written back. */
export interface EntryPointColoring {
  /** anchor → business domain (owner). */
  owner: Map<AnchorId, string>;
  /** anchor → program domain (belongs-to). */
  programDomain: Map<AnchorId, string>;
}
