/**
 * Anatomia — top-level barrel.
 * Re-exports core types (T02) and sub-module barrels.
 */

// Core types (T02)
export type {
  AnchorId,
  AstNode,
  SourcePosition,
  SourceRange,
  FunctionNode,
  FileNode,
  EdgeKind,
  CodeNode,
  Edge,
  RuleSeverity,
  RuleScope,
  Rule,
  Violation,
  LinkEvidence,
  SpecClause,
  Link,
  ContextBundle,
  GateResult,
  Verdict,
} from "./types.js";

// Sub-module placeholders (implementations added by later tasks)
export * from "./dag/index.js";
export * from "./graph/index.js";
export * from "./mechanics/index.js";
export * from "./spec/index.js";
export * from "./supply/index.js";
export * from "./adapters/index.js";
export * from "./dynamic/index.js";
export * from "./plugins/index.js";
