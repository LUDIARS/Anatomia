import { relative } from 'node:path';
import type { AnalysisContext } from '../core.js';
import type { FieldInfo, FunctionNode, ParamInfo } from '../types.js';

export type FocusPriority = 'critical' | 'high' | 'medium' | 'low';
export type FocusRisk =
  | 'boundary'
  | 'memory_safety'
  | 'authorization'
  | 'state_transition'
  | 'concurrency'
  | 'contract';

export interface VariableFocusPolicy {
  pattern: string;
  priority: FocusPriority;
}

export interface DomainFocusPolicy {
  domain: string;
  priority: FocusPriority;
  risks: FocusRisk[];
  variables: VariableFocusPolicy[];
  rationale?: string;
}

export interface FocusedVariableFact {
  name: string;
  kind: 'parameter' | 'field';
  priority: FocusPriority;
  type?: string;
}

export interface FocusedTargetFact {
  symbol: string;
  file: string;
  line: number;
  variables: FocusedVariableFact[];
}

export interface FocusedDomainFact {
  domain: string;
  priority: FocusPriority;
  risks: FocusRisk[];
  inferredRisks?: FocusRisk[];
  rationale?: string;
  targets: FocusedTargetFact[];
}

export interface FocusedTestingFacts {
  source: 'anatomia';
  domains: FocusedDomainFact[];
}

export class FocusedTestingError extends Error {}

const PRIORITY_RANK: Record<FocusPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

interface VariableCandidate {
  name: string;
  kind: 'parameter' | 'field';
  type?: string;
}

function fieldCandidates(ctx: AnalysisContext): Map<string, VariableCandidate[]> {
  const byType = new Map<string, VariableCandidate[]>();
  for (const file of ctx.files) {
    for (const declaration of file.types ?? []) {
      const fields = (declaration.fields ?? []).map((field: FieldInfo) => ({
        name: field.name,
        kind: 'field' as const,
        ...(field.type !== null ? { type: field.type } : {}),
      }));
      byType.set(declaration.name, [...(byType.get(declaration.name) ?? []), ...fields]);
    }
  }
  return byType;
}

function parameterCandidates(fn: FunctionNode): VariableCandidate[] {
  return (fn.params ?? []).map((parameter: ParamInfo) => ({
    name: parameter.name,
    kind: 'parameter',
    ...(parameter.type !== null ? { type: parameter.type } : {}),
  }));
}

function matchVariables(
  candidates: VariableCandidate[],
  policies: VariableFocusPolicy[],
): FocusedVariableFact[] {
  const matched = new Map<string, FocusedVariableFact>();
  for (const candidate of candidates) {
    for (const policy of policies) {
      if (!candidate.name.toLowerCase().includes(policy.pattern.toLowerCase())) continue;
      const key = `${candidate.kind}:${candidate.name}`;
      const previous = matched.get(key);
      if (previous !== undefined && PRIORITY_RANK[previous.priority] <= PRIORITY_RANK[policy.priority]) continue;
      matched.set(key, { ...candidate, priority: policy.priority });
    }
  }
  return [...matched.values()].sort((a, b) => compareText(a.name, b.name) || compareText(a.kind, b.kind));
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

const RISK_ORDER: FocusRisk[] = [
  'boundary',
  'memory_safety',
  'authorization',
  'state_transition',
  'concurrency',
  'contract',
];

function inferRisks(functions: FunctionNode[], priority: FocusPriority): FocusRisk[] {
  const text = functions.map((fn) => [
    fn.name,
    fn.signature,
    ...(fn.params ?? []).map((parameter) => `${parameter.name} ${parameter.type ?? ''}`),
    fn.bodyAst.text ?? '',
  ].join(' ')).join(' ').toLowerCase();
  const risks = new Set<FocusRisk>(['boundary', 'contract']);
  const hasNativeCriticalTarget = priority === 'critical' && functions.some((fn) => /\.(cpp|cc|cxx|h|hpp)$/i.test(fn.sourceRange.filePath));
  if (hasNativeCriticalTarget || /\b(new|delete|malloc|free|buffer|span|pointer|index|count|size)\b|[*&]/.test(text)) {
    risks.add('memory_safety');
  }
  if (/\b(auth|permission|owner|token|validate|verify|server|command|action|input|player)\w*/.test(text)) {
    risks.add('authorization');
  }
  if (/\b(state|status|phase|transition|apply|reduce|health|score|inventory|progress)\w*/.test(text)) {
    risks.add('state_transition');
  }
  if (/\b(async|await|promise|task|thread|mutex|lock|atomic|concurr)\w*/.test(text)) {
    risks.add('concurrency');
  }
  return RISK_ORDER.filter((risk) => risks.has(risk));
}

function relativePath(repoPath: string, filePath: string): string {
  return relative(repoPath, filePath).replace(/\\/g, '/');
}

export function buildFocusedTestingFacts(
  ctx: AnalysisContext,
  policies: DomainFocusPolicy[],
): FocusedTestingFacts {
  const functionsById = new Map(
    ctx.functions.flatMap((fn) => fn.id === null ? [] : [[fn.id, fn] as const]),
  );
  const fieldsByType = fieldCandidates(ctx);
  const domains = policies.map((policy): FocusedDomainFact => {
    const detection = (ctx.domains ?? []).find((candidate) => candidate.domain === policy.domain);
    if (detection === undefined) {
      throw new FocusedTestingError(`focusedTesting domain "${policy.domain}" was not found in Anatomia analysis`);
    }
    const implementors = detection.implementors
      .map((anchor) => functionsById.get(anchor))
      .filter((fn): fn is FunctionNode => fn !== undefined);
    if (implementors.length === 0) {
      throw new FocusedTestingError(`focusedTesting domain "${policy.domain}" has no analyzed implementors`);
    }
    const targets = implementors.map((fn): FocusedTargetFact => {
      const candidates = [
        ...parameterCandidates(fn),
        ...(fn.enclosingType !== undefined ? fieldsByType.get(fn.enclosingType) ?? [] : []),
      ];
      return {
        symbol: fn.name,
        file: relativePath(ctx.repoPath, fn.sourceRange.filePath),
        line: fn.sourceRange.start.line,
        variables: matchVariables(candidates, policy.variables),
      };
    }).sort((a, b) => compareText(a.file, b.file) || a.line - b.line || compareText(a.symbol, b.symbol));
    if (policy.variables.length > 0 && targets.every((target) => target.variables.length === 0)) {
      throw new FocusedTestingError(
        `focusedTesting variable patterns for domain "${policy.domain}" matched no analyzed parameters or fields`,
      );
    }
    const inferredRisks = policy.risks.length === 0 ? inferRisks(implementors, policy.priority) : undefined;
    return {
      domain: policy.domain,
      priority: policy.priority,
      risks: inferredRisks ?? [...policy.risks],
      ...(inferredRisks !== undefined ? { inferredRisks } : {}),
      ...(policy.rationale !== undefined ? { rationale: policy.rationale } : {}),
      targets,
    };
  });
  return { source: 'anatomia', domains };
}
