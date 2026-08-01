/**
 * Explicit state for code that has no approved semantic domain assignment.
 *
 * This is a relation state, not a DomainDef: callers must not materialize an
 * `unassigned` domain node or use it as a catch-all owner.
 */
export const UNASSIGNED_DOMAIN = "unassigned" as const;

/** True when a name is reserved for a relation state rather than a domain node. */
export function isReservedDomainName(name: string): boolean {
  return name.trim().toLowerCase() === UNASSIGNED_DOMAIN;
}

/** Reject materialising a relation-state sentinel as a DomainDef. */
export function assertDomainDefinitionName(name: string): void {
  if (isReservedDomainName(name)) {
    throw new Error(
      `domain name "${name}" is reserved for the unassigned relation state and cannot be a DomainDef`,
    );
  }
}
