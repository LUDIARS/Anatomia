import type { KnowledgeEdge, KnowledgeNode } from "../types.js";

export type SceneDefinitionOrigin = "static-code" | "engine-asset" | "route" | "workflow";

export interface SceneSourceAnchor {
  path: string;
  startLine: number;
  endLine: number;
  detector: string;
  reason: string;
}

export interface SceneDefinitionSeed {
  sceneId: string;
  nativeIdentity: string;
  identityBasis: "native-id" | "explicit-id" | "route-id" | "qualified-entry" | "source-fallback";
  label: string;
  kind: string;
  origin: SceneDefinitionOrigin;
  sourceRevision: string;
  sourceAnchor: SceneSourceAnchor;
  entryAnchorIds: string[];
  referenceKeys: string[];
  containsRefs: string[];
  transitionRefs: string[];
  aliases: string[];
  tombstone: boolean;
}

export interface SceneObservation {
  observationId: string;
  traceRevision: string;
  sceneId: string | null;
  observedAnchorIds: string[];
  frameRange: { start: number; end: number } | null;
  confidence: number;
  provisionalDiagnostic: string | null;
}

export interface CanonicalSceneElement {
  id: string;
  label: string;
  sourceAnchor: SceneSourceAnchor;
  realizedByCodeSymbolIds: string[];
}

export interface CanonicalScene {
  id: string;
  nativeIdentity: string;
  referenceKeys: string[];
  label: string;
  kind: string;
  origin: SceneDefinitionOrigin;
  sourceRevision: string;
  identityBasis: SceneDefinitionSeed["identityBasis"];
  sourceAnchor: SceneSourceAnchor;
  aliases: string[];
  tombstone: boolean;
  entryCodeSymbolIds: string[];
  reachedCodeSymbolIds: string[];
  activeDomainIds: string[];
  relatedSpecClauseIds: string[];
  containedSceneIds: string[];
  transitionSceneIds: string[];
  elements: CanonicalSceneElement[];
}

export interface CanonicalSceneGraph {
  schemaVersion: 1;
  projectId: string;
  sourceRevision: string;
  definitionFingerprint: string;
  scenes: CanonicalScene[];
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
}

export interface SceneManifest {
  schemaVersion: 1;
  projectionSchema: 1;
  projectId: string;
  knowledgeHead: string;
  sourceRevision: string;
  definitionFingerprint: string;
  scenes: CanonicalScene[];
}

export interface SceneAnnotation {
  sceneId: string;
  label?: string;
  description?: string;
  reviewNote?: string;
}

export interface SceneInspection {
  manifest: SceneManifest;
  scenes: Array<CanonicalScene & { annotation: SceneAnnotation | null }>;
  observations: SceneObservation[];
  stale: boolean;
  staleReasons: string[];
}
