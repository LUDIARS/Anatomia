/**
 * src/knowledge/entrypoint/types.ts — Canonical shapes for the entry-point layer.
 *
 * The derived entry graph (entrypoints/derive.ts) is the payload; this wraps it
 * with the knowledge-log records that the code-sync transaction replaces, the
 * same shape the scene and program-domain layers use.
 *
 * SRP: type definitions only.
 */

import type { EntryPointGraph } from "../../entrypoints/types.js";
import type { KnowledgeEdge, KnowledgeNode } from "../types.js";

/** One derived entry-point set, ready to commit + project. */
export interface CanonicalEntryPointGraph {
  projectId: string;
  sourceRevision: string;
  definitionFingerprint: string;
  graph: EntryPointGraph;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
}

/** The `<generated>/entrypoint-graph.json` artifact. */
export interface EntryPointGraphManifest {
  schemaVersion: 1;
  projectionSchema: 1;
  projectId: string;
  knowledgeHead: string;
  sourceRevision: string;
  definitionFingerprint: string;
  entries: EntryPointGraph["entries"];
  graphNodes: EntryPointGraph["nodes"];
  graphEdges: EntryPointGraph["edges"];
  unrooted: EntryPointGraph["unrooted"];
  diagnostics: EntryPointGraph["diagnostics"];
}
