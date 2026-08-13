import type { ModuleUnit } from "../../modules/types.js";

/** Repository-owned, deterministic layer declaration. */
export interface ProgramLayerRule { glob: string; layer: string }

export interface ProgramDomainConfig {
  layers: ProgramLayerRule[];
  mergeCouplingThreshold: number;
}

export interface ProgramSymbol {
  id: string;
  moduleId: string;
  path: string;
  /** Framework detector result, used only after repository rules. */
  frameworkLayer?: string;
  /** Deterministic dependency facts supplied by the analyzer. */
  dependencies?: readonly ("ui" | "persistence")[];
}

export interface ProgramDiagnostic {
  kind: "unclassified";
  moduleId: string;
  symbolIds: string[];
  reason: "no-layer-rule";
}

export interface ClassifiedModule { module: ModuleUnit; layer: string | null; source: "builtin" | "config" | "framework" | "heuristic" | null }

export interface ProgramDomain {
  id: string;
  layer: string;
  moduleIds: string[];
  codeSymbolIds: string[];
}

export interface ProgramDomainGraph {
  schemaVersion: 1;
  projectId: string;
  sourceRevision: string;
  definitionFingerprint: string;
  domains: ProgramDomain[];
  diagnostics: ProgramDiagnostic[];
}
