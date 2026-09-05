/**
 * src/adapters/web/routes/ux-critical-policies.ts — Making UX-critical domains
 * mandatory in a test-suggestion request (A-10).
 *
 * `focusedTesting` is caller-supplied: whoever asks for suggestions decides
 * which domains to focus on. A UX-critical domain is exactly the one a caller
 * must not be able to leave out — "domains that touch UX get stronger review and
 * stronger tests" is a policy, not a preference — so this merges those domains
 * into the request at `critical` priority before Augur sees it.
 *
 * The domain names come from the approved `domain-owns-code` bridge, NOT from a
 * name match against the business taxonomy (ux-critical-bridge.ts explains why),
 * and a domain the analysis does not know is skipped: `buildFocusedTestingFacts`
 * throws on an unknown domain, and a mandatory policy must not turn a valid
 * request into a 400.
 *
 * SRP: policy merging. Resolution is the bridge; fact building is
 * domains/focused-testing.ts.
 *
 * @spec UX 直結ドメインの plan / test-suggestions への引き継ぎ (A-10)
 */

import type { DomainFocusPolicy } from "../../../domains/focused-testing.js";

/** Note added to the response so the caller sees the request was widened. */
export const UX_CRITICAL_CONSTRAINT =
  "UX-critical domains are mandatory: test suggestions must cover them (Anatomia A-10).";

/**
 * Merge the UX-critical domains into the caller's focus policies.
 *
 * An already-listed domain keeps the caller's own variable patterns but is
 * raised to `critical`: the caller said what to look at, the policy says how
 * hard to look. Returns `undefined` only when there is nothing to focus on at
 * all, so an untouched request stays untouched.
 */
export function withUxCriticalPolicies(
  requested: DomainFocusPolicy[] | undefined,
  uxCriticalDomains: readonly string[],
  analysedDomains: ReadonlySet<string>,
): { policies: DomainFocusPolicy[] | undefined; added: string[]; raised: string[] } {
  const mandatory = [...new Set(uxCriticalDomains)].filter((name) => analysedDomains.has(name)).sort();
  if (mandatory.length === 0) return { policies: requested, added: [], raised: [] };

  const byDomain = new Map((requested ?? []).map((policy) => [policy.domain, policy] as const));
  const added: string[] = [];
  const raised: string[] = [];
  for (const domain of mandatory) {
    const existing = byDomain.get(domain);
    if (!existing) {
      added.push(domain);
      byDomain.set(domain, { domain, priority: "critical", risks: [], variables: [] });
      continue;
    }
    if (existing.priority !== "critical") {
      raised.push(domain);
      byDomain.set(domain, { ...existing, priority: "critical" });
    }
  }
  const policies = [...byDomain.values()].sort((left, right) => left.domain.localeCompare(right.domain));
  return { policies, added, raised };
}
