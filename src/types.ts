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
export type Lang = "cpp" | "c_sharp" | "typescript" | "tsx";

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

export type NodeKind = "function" | "method" | "class" | "module" | "file";

export interface CodeNode {
  id: AnchorId;
  name: string;
  kind: NodeKind;
  sourceRange: SourceRange;
  /**
   * Optional classification tags (e.g. "hotPath", "alloc", layer names).
   * Used by the domains rule engine's NodeFilter (G3, DESIGN §4.3).
   * Tagging is supplied externally (domain ontology / heuristics); the static
   * DAG layer does not assign tags.
   */
  tags?: string[];
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
export type RuleScope = "global" | "domain";

/**
 * Severity attached to a concrete violation (distinct from a Rule's
 * block/warn gate severity). Mirrors common linter levels.
 */
export type ViolationSeverity = "error" | "warning" | "info";

// ── Predicate ADT (T14) ────────────────────────────────────────────────────

/**
 * A NodeFilter matches CodeNodes by kind, name (regex), source-path (regex)
 * and/or tags. All present fields are ANDed. An empty filter matches every node.
 */
export interface NodeFilter {
  /** Match nodes of this kind. */
  kind?: NodeKind;
  /** Match nodes whose name matches this regex (JS RegExp source). */
  namePattern?: string;
  /**
   * Match nodes whose source file path matches this regex (JS RegExp source).
   * Tested against the path normalised to forward slashes, so a pattern like
   * `/enemy/` matches regardless of OS path separator. This is the lever for
   * directory-based architecture rules (layer = location).
   */
  pathPattern?: string;
  /** Match nodes that carry ALL of these tags. */
  tags?: string[];
}

/**
 * Concrete, serializable predicate representation (discriminated union).
 * Evaluated by evaluatePredicate() in domains/engine.ts (T14).
 *
 * This replaces the scaffold's opaque `Rule.predicate: unknown`.
 */
export type Predicate =
  /** No edge of `kind` may exist between a `from`-match and a `to`-match. */
  | { type: "EdgeForbidden"; from: NodeFilter; to: NodeFilter; kind: EdgeKind }
  /** Fan-in (incoming edges, optionally of `kind`) of each target ≤ max. */
  | { type: "FanInCap"; target: NodeFilter; max: number; kind?: EdgeKind }
  /** Fan-out (outgoing edges, optionally of `kind`) of each target ≤ max. */
  | { type: "FanOutCap"; target: NodeFilter; max: number; kind?: EdgeKind }
  /** No cycle may exist among nodes matching `scope` (following `kind`). */
  | { type: "NoCycle"; scope: NodeFilter; kind?: EdgeKind }
  /** References a template rule (compiled in T16). */
  | { type: "TemplatePredicate"; templateId: string }
  | { type: "And"; children: Predicate[] }
  | { type: "Or"; children: Predicate[] }
  | { type: "Not"; child: Predicate };

/**
 * An architectural rule (DESIGN §4.3): scope + concrete predicate + gate
 * severity.
 */
export interface Rule {
  id: string;
  scope: RuleScope;
  /** Human-readable description. */
  description: string;
  /** Concrete, serializable predicate (T14). */
  predicate: Predicate;
  severity: RuleSeverity;
}

/**
 * A concrete rule violation (T14). `anchors` lists every code anchor involved;
 * `evidence` is a human-readable explanation string.
 */
export interface Violation {
  ruleId: string;
  /** All code anchors involved in this violation. */
  anchors: AnchorId[];
  /** Human-readable evidence / explanation. */
  evidence: string;
  severity: ViolationSeverity;
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
  /** True once a human or automated gate has ratified this link. */
  ratified?: boolean;
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
  /** Rules that apply: global ∪ domain-specific. */
  applicableRules: Rule[];
  /** Spec clauses linked to the landing anchor. */
  specClauses: SpecClause[];
  /** Example sibling functions that define local conventions. */
  exemplars: FunctionNode[];
  /** KG-derived set of anchors that could be affected by changes here. */
  impactRadius: AnchorId[];
  /** Existing domains that subsume this task (duplication guard). */
  existingDomains: string[];
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
