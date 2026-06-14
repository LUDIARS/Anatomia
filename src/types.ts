/**
 * Core types for Anatomia (T02).
 * Types only — no logic, no circular imports.
 * The AstNode placeholder is filled by T03 (web-tree-sitter integration).
 */

import type { Node as TreeSitterNode } from "web-tree-sitter";

// ---------------------------------------------------------------------------
// Branded primitives
// ---------------------------------------------------------------------------

/** Normalized Merkle hash of a function body (α-normalized). Filled by T06. */
export type AnchorId = string & { readonly __brand: "AnchorId" };

// ---------------------------------------------------------------------------
// AST node (web-tree-sitter, T03)
// ---------------------------------------------------------------------------

/**
 * A tree-sitter syntax node. In web-tree-sitter 0.25 the concrete class is
 * named `Node` (formerly `SyntaxNode`); we alias it here so the rest of the
 * codebase has a single stable name.
 */
export type AstNode = TreeSitterNode;

/** Supported source languages (tree-sitter grammar identifiers). */
export type Lang = "cpp" | "c_sharp";

// ---------------------------------------------------------------------------
// Source location
// ---------------------------------------------------------------------------

export interface SourcePosition {
  line: number;
  column: number;
}

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
  /** Absolute path to the source file. */
  filePath: string;
}

// ---------------------------------------------------------------------------
// Static DAG nodes (G1)
// ---------------------------------------------------------------------------

/** A function or method extracted from source. */
export interface FunctionNode {
  /** Filled by T06 after normalization + hashing. Null before hash step. */
  id: AnchorId | null;
  name: string;
  /** Full signature text (return type + params). */
  signature: string;
  sourceRange: SourceRange;
  /** Raw AST subtree for this function body. */
  bodyAst: AstNode;
}

/** A source file modelled as a Merkle node over its function set. */
export interface FileNode {
  /** Absolute path. */
  path: string;
  /** Merkle hash of this file (hash of sorted child function hashes). Filled by T07. */
  hash: string | null;
  functions: FunctionNode[];
}

// ---------------------------------------------------------------------------
// Code graph (G2)
// ---------------------------------------------------------------------------

export type EdgeKind =
  | "calls"
  | "depends"
  | "reads"
  | "writes"
  | "implements"
  | "overrides"
  | "includes";

export interface CodeNode {
  id: AnchorId;
  name: string;
  kind: "function" | "method" | "class" | "module" | "file";
  sourceRange: SourceRange;
}

export interface Edge {
  from: AnchorId;
  to: AnchorId;
  kind: EdgeKind;
}

// ---------------------------------------------------------------------------
// Architecture rules (G3, DESIGN §4.3)
// ---------------------------------------------------------------------------

export type RuleSeverity = "block" | "warn";
export type RuleScope = "global" | "mechanic";

/**
 * An architectural rule.
 * `predicate` is opaque at scaffold time; T14 will define the evaluated form.
 */
export interface Rule {
  id: string;
  scope: RuleScope;
  /** Human-readable description. */
  description: string;
  /** Opaque predicate; evaluated by the rule engine (T14). */
  predicate: unknown;
  severity: RuleSeverity;
}

export interface Violation {
  ruleId: string;
  severity: RuleSeverity;
  /** The code node that violates the rule. */
  anchor: AnchorId;
  /** Human-readable explanation. */
  message: string;
  /** Supporting evidence (anchor IDs of nodes involved). */
  evidence: AnchorId[];
}

// ---------------------------------------------------------------------------
// Code ↔ Spec linking (G4, DESIGN §4.5)
// ---------------------------------------------------------------------------

export type LinkEvidence = "explicit" | "structural" | "semantic";

/** A parsed clause from a spec document (e.g. a §-section or bullet). */
export interface SpecClause {
  id: string;
  /** Source file (spec/*.md, DESIGN.md, …). */
  sourceFile: string;
  /** Section heading path, e.g. "§4.5 / リンカ". */
  heading: string;
  /** Raw text of the clause. */
  text: string;
  /** Embedding vector placeholder; filled by T24. */
  embedding: number[] | null;
}

/** A directional link between a code anchor and a spec clause. */
export interface Link {
  from: AnchorId;
  to: string; // SpecClause.id
  confidence: number; // 0.0–1.0
  evidence: LinkEvidence;
}

// ---------------------------------------------------------------------------
// Supply / Verify (G5, DESIGN §9.1)
// ---------------------------------------------------------------------------

/**
 * A deterministic context bundle passed to AI before code generation.
 * `orderSegments` (llm-gateway) arranges immutable-first, mutable-last.
 */
export interface ContextBundle {
  /** Target anchor where new code should land. */
  landingAnchor: AnchorId | null;
  /** Rules that apply: global ∪ mechanic-specific. */
  applicableRules: Rule[];
  /** Spec clauses linked to the landing anchor. */
  specClauses: SpecClause[];
  /** Example sibling functions that define local conventions. */
  exemplars: FunctionNode[];
  /** KG-derived set of anchors that could be affected by changes here. */
  impactRadius: AnchorId[];
  /** Existing mechanics that subsume this task (duplication guard). */
  existingMechanics: string[];
}

/** A gate within the verify step. */
export interface GateResult {
  gate:
    | "rule_conformance"
    | "duplication"
    | "spec_linkage"
    | "coupling_delta"
    | "convention_drift";
  pass: boolean;
  anchors: AnchorId[];
  /** Human-readable suggestion for fixing the failure. */
  suggestion: string | null;
}

/** Structured verdict returned by verify (DESIGN §9.1 ③). */
export interface Verdict {
  /** Overall pass only when all `block`-severity gates pass. */
  pass: boolean;
  gates: GateResult[];
  /** All anchors directly involved in violations. */
  anchors: AnchorId[];
  /** Top-level suggestion summarising required fixes. */
  suggestion: string | null;
}
