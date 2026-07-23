/**
 * domains/ — Domain detection, rules engine, domain cards (G3).
 *
 * Pipeline:
 *   predicate.ts  (T14) — NodeFilter matching helpers
 *   engine.ts     (T14) — evaluatePredicate over the Predicate ADT (types.ts)
 *   presets.ts    (T15) — parameterized preset factories -> Predicate
 *   matcher.ts    (T16) — structural template matcher (AST)
 *   template.ts   (T16) — TemplateRule -> TemplatePredicate + evaluation
 *   mining.ts     (T17) — reverse rule generation from an exemplar
 *   ontology.ts   (T18) — domain-ontology plugin loader + builtins
 *   detect.ts     (T19) — domain detection (conformance)
 *   card.ts       (T20) — content-keyed domain-card generation (injected LLM)
 */

// T14 — predicate engine
export { matchesFilter, selectNodes } from "./predicate.js";
export { evaluatePredicate } from "./engine.js";
export type { TemplateResolver, EvaluateOptions } from "./engine.js";

// T15 — presets
export {
  layerDependencyDirection,
  stateAccessPath,
  forbiddenCall,
  couplingCap,
  noCycle,
  hotPathNoAlloc,
  buildPresetPredicate,
  PRESET_FACTORIES,
} from "./presets.js";
export type { PresetId } from "./presets.js";

// T16 — templates
export { isMetavar, decodeMetavar, matchTemplateAst } from "./matcher.js";
export type { MatchResult } from "./matcher.js";
export {
  encodePattern,
  compileTemplate,
  matchTemplate,
  evaluateTemplate,
  makeTemplateResolver,
} from "./template.js";
export type { TemplateRule } from "./template.js";

// T17 — mining
export { mineRules } from "./mining.js";
export type { CandidateRule, MiningOptions } from "./mining.js";

// T18 — ontology loader
export { loadOntology, BUILTIN_DOMAINS } from "./ontology.js";
export type { DomainDef, ConfiguredPreset, DomainOntology } from "./ontology.js";

// T19 — detection
export { detectDomain, detectDomains } from "./detect.js";
export type { DetectionResult } from "./detect.js";

// T20 — card generation
export {
  createCardCache,
  generateCard,
  assemblePrompt,
  merkleHash,
} from "./card.js";
export type { LLMClient, DomainCard, CardCache } from "./card.js";

// Deterministic analysis facts for caller-prioritized testing.
export { buildFocusedTestingFacts, FocusedTestingError } from "./focused-testing.js";
export type {
  DomainFocusPolicy,
  FocusedDomainFact,
  FocusedTargetFact,
  FocusedTestingFacts,
  FocusedVariableFact,
  FocusPriority,
  FocusRisk,
  VariableFocusPolicy,
} from "./focused-testing.js";

// Domain organization (human-authored taxonomy + implementation hints)
export * from "./organize/index.js";

// Human-gated discovery: deterministic orphan evidence + LLM/spec proposals.
export * from "./discovery/index.js";
export * from "./workflow/index.js";
