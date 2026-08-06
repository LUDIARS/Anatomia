import type { KnowledgeTransaction, KnowledgeTransactionDraft } from "../types.js";

export type LegacyArtifactKind = "editable-domain" | "domain-def" | "taxonomy" | "screens" | "manual-scenes";

export interface LegacyArtifactInventory {
  kind: LegacyArtifactKind;
  path: string;
  exists: boolean;
  recordCount: number;
  contentHash: string | null;
}

export interface LegacyMigrationConflict {
  code: "duplicate-domain" | "invalid-artifact" | "unmatched-manual-scene" | "annotation-collision" | "stale-scene-manifest";
  path: string;
  detail: string;
}

export interface LegacyAnnotationWrite {
  sceneId: string;
  /** Path relative to the configured knowledge write root. */
  path: string;
  content: string;
}

export interface LegacyMigrationPlan {
  schemaVersion: 1;
  projectId: string;
  expectedHead: string | null;
  sourceFingerprint: string;
  inventory: LegacyArtifactInventory[];
  transactionDraft: KnowledgeTransactionDraft;
  annotationWrites: LegacyAnnotationWrite[];
  conflicts: LegacyMigrationConflict[];
  warnings: string[];
  canApply: boolean;
  originalsRetained: true;
}

export interface LegacyMigrationApplyRequest {
  confirmApply: boolean;
  expectedSourceFingerprint: string;
  expectedHead: string | null;
}

export interface LegacyMigrationApplyResult {
  transaction: KnowledgeTransaction;
  annotationPaths: string[];
  originalsRetained: true;
}
