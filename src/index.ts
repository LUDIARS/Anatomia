/**
 * Anatomia — top-level barrel.
 * Re-exports core types (T02) and sub-module barrels.
 */

// Core types (T02 + T03)
export type {
  AnchorId,
  AstNode,
  Lang,
  SourcePosition,
  SourceRange,
  FunctionNode,
  FileNode,
  EdgeKind,
  NodeKind,
  CodeNode,
  Edge,
  RuleSeverity,
  RuleScope,
  ViolationSeverity,
  NodeFilter,
  Predicate,
  Rule,
  Violation,
  LinkEvidence,
  SpecClause,
  Link,
  ContextBundle,
  GateResult,
  Verdict,
} from "./types.js";

// Core wiring (G9 — e2e entry points: analyze / context / verify / impact)
export {
  analyze,
  buildContextBundle,
  buildVerdict,
  getImpactRadius,
} from "./core.js";
export type {
  AnalysisContext,
  AnalyzeOptions,
  BundleRequest,
} from "./core.js";

// Sub-module placeholders (implementations added by later tasks)
export * from "./cache/index.js";
export * from "./dag/index.js";
export * from "./graph/index.js";
export * from "./domains/index.js";
export * from "./spec/index.js";
export * from "./spec-review/index.js";
export * from "./supply/index.js";
export * from "./adapters/index.js";
export * from "./dynamic/index.js";
export * from "./plugins/index.js";
export * from "./project/index.js";
