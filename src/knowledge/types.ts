import type { SpecClause } from "../types.js";

export type KnowledgeNodeKind =
  | "domain"
  | "spec-document"
  | "spec-clause"
  | "code-symbol"
  | "program-domain"
  | "scene"
  | "scene-element"
  | "entry-point"
  | "refactoring-proposal";

export type KnowledgeEdgeKind =
  | "subdomain-of"
  /** Context-map relation between two core domains; `evidence.relation` carries the kind. */
  | "domain-relates-domain"
  | "domain-owns-spec"
  | "domain-relates-spec"
  | "domain-owns-code"
  | "program-domain-contains-code"
  | "domain-uses-code"
  | "code-relates-spec"
  | "scene-contains"
  | "subscene-of"
  | "scene-transitions-to"
  | "scene-has-entry"
  | "scene-activates-code"
  | "scene-activates-domain"
  | "scene-relates-spec"
  | "scene-element-realized-by"
  | "entry-point-has-symbol"
  | "entry-point-activates-domain";

export interface RevisionEvidence {
  sourceRevision: string;
  contentFingerprint: string;
  sourcePath?: string;
  sourceRange?: { startLine: number; endLine: number };
}

export interface KnowledgeNode {
  id: string;
  kind: KnowledgeNodeKind;
  aliases?: string[];
  revision: RevisionEvidence;
  data?: Record<string, unknown>;
}

export interface KnowledgeEdge {
  id: string;
  kind: KnowledgeEdgeKind;
  from: string;
  to: string;
  evidence?: Record<string, unknown>;
}

export type KnowledgeOperation =
  | { op: "upsert-node"; record: KnowledgeNode }
  | { op: "upsert-edge"; record: KnowledgeEdge }
  | { op: "remove-node"; id: string }
  | { op: "remove-edge"; id: string }
  | {
    op: "replace-derived-set";
    owner: string;
    nodes: KnowledgeNode[];
    edges: KnowledgeEdge[];
  };

export interface KnowledgeTransaction {
  schemaVersion: 1;
  transactionId: string;
  previousHead: string | null;
  transactionHash: string;
  analysisSnapshotId: string;
  sourceRevisions: Record<string, unknown>;
  origin: "human-approval" | "code-sync" | "migration";
  operations: KnowledgeOperation[];
  provenance: {
    proposalIds: string[];
    approval: {
      kind: "human" | "agent" | "automatic" | "migration";
      reviewRef: string | null;
    };
    generatorSchema: number;
  };
}

export type KnowledgeTransactionDraft = Omit<
  KnowledgeTransaction,
  "schemaVersion" | "previousHead" | "transactionHash"
>;

export interface KnowledgeGraph {
  head: string | null;
  transactions: KnowledgeTransaction[];
  nodes: Map<string, KnowledgeNode>;
  edges: Map<string, KnowledgeEdge>;
}

export type OkfRoutingKind =
  | "specification"
  | "domain"
  | "scene"
  | "scene-annotation"
  | string;

export interface OkfProfile {
  type?: "data" | "feature" | "interface" | "plan" | "setup" | "test";
  title?: string;
  service?: string;
  domain?: string;
  status?: string;
  anatomia: {
    kind: OkfRoutingKind;
    id?: string;
    generated: boolean;
    domainRefs: string[];
    symbolRefs: string[];
  };
  raw: Record<string, unknown>;
}

export interface ParsedOkfDocument {
  route: "authored-spec" | "domain" | "scene" | "scene-annotation" | "generated";
  documentId: string;
  explicitDocumentId: boolean;
  profile: OkfProfile;
  sourceRevision: string;
  sourceFile: string;
  clauses: SpecClause[];
}

export interface GeneratedArtifact {
  path: string;
  content: string | Uint8Array;
  entityId: string;
}

export interface GeneratedManifestEntry {
  path: string;
  contentHash: string;
  entityId: string;
}

export interface GeneratedManifest {
  schemaVersion: 1;
  generatorSchema: number;
  projectionSchema: number;
  knowledgeHead: string | null;
  sourceRevision: string;
  sourceFingerprint: string;
  outputFingerprint: string;
  files: GeneratedManifestEntry[];
}
