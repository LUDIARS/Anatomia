import type {
  DomainFocusPolicy,
  FocusPriority,
  FocusRisk,
  VariableFocusPolicy,
} from '../../../domains/focused-testing.js';
import { FocusedTestingError } from '../../../domains/focused-testing.js';

const PRIORITIES = new Set<FocusPriority>(['critical', 'high', 'medium', 'low']);
const RISKS = new Set<FocusRisk>([
  'boundary',
  'memory_safety',
  'authorization',
  'state_transition',
  'concurrency',
  'contract',
]);

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FocusedTestingError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FocusedTestingError(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function priority(value: unknown, path: string): FocusPriority {
  const parsed = nonEmptyString(value, path) as FocusPriority;
  if (!PRIORITIES.has(parsed)) {
    throw new FocusedTestingError(`${path} must be one of critical, high, medium, low`);
  }
  return parsed;
}

function variablePolicies(value: unknown, path: string): VariableFocusPolicy[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new FocusedTestingError(`${path} must be an array`);
  if (value.length > 50) throw new FocusedTestingError(`${path} must contain at most 50 entries`);
  return value.map((entry, index) => {
    const item = objectValue(entry, `${path}[${index}]`);
    return {
      pattern: nonEmptyString(item.pattern, `${path}[${index}].pattern`),
      priority: priority(item.priority, `${path}[${index}].priority`),
    };
  });
}

function risks(value: unknown, path: string): FocusRisk[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new FocusedTestingError(`${path} must be an array`);
  const parsed = value.map((entry, index) => nonEmptyString(entry, `${path}[${index}]`) as FocusRisk);
  for (const risk of parsed) {
    if (!RISKS.has(risk)) {
      throw new FocusedTestingError(`${path} contains unsupported risk "${risk}"`);
    }
  }
  return [...new Set(parsed)];
}

export function parseFocusedTestingInput(value: unknown): DomainFocusPolicy[] | undefined {
  if (value === undefined) return undefined;
  const root = objectValue(value, 'focusedTesting');
  if (!Array.isArray(root.domains) || root.domains.length === 0) {
    throw new FocusedTestingError('focusedTesting.domains must be a non-empty array');
  }
  if (root.domains.length > 20) {
    throw new FocusedTestingError('focusedTesting.domains must contain at most 20 entries');
  }
  const seen = new Set<string>();
  return root.domains.map((entry, index) => {
    const item = objectValue(entry, `focusedTesting.domains[${index}]`);
    const domain = nonEmptyString(item.domain, `focusedTesting.domains[${index}].domain`);
    if (seen.has(domain)) throw new FocusedTestingError(`duplicate focusedTesting domain "${domain}"`);
    seen.add(domain);
    const rationale = item.rationale === undefined
      ? undefined
      : nonEmptyString(item.rationale, `focusedTesting.domains[${index}].rationale`);
    return {
      domain,
      priority: priority(item.priority, `focusedTesting.domains[${index}].priority`),
      risks: risks(item.risks, `focusedTesting.domains[${index}].risks`),
      variables: variablePolicies(item.variables, `focusedTesting.domains[${index}].variables`),
      ...(rationale !== undefined ? { rationale } : {}),
    };
  });
}
