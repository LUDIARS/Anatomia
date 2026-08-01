/**
 * Validate taxonomy domain identities at persisted-data and derivation
 * boundaries. A taxonomy domain becomes a DomainDef/ownership node, so relation
 * state sentinels are not valid names here.
 */

import { assertDomainDefinitionName } from "../assignment.js";
import type { Taxonomy } from "./types.js";

/** Reject malformed or reserved taxonomy domain names before they become active. */
export function assertTaxonomyDomainNames(
  taxonomy: Pick<Taxonomy, "domains">,
): void {
  for (const domain of taxonomy.domains) {
    if (!domain || typeof domain.name !== "string") {
      throw new Error("invalid taxonomy domain: expected a string name");
    }
    assertDomainDefinitionName(domain.name);
  }
}
