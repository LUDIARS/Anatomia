import type { KnowledgeEdge, KnowledgeNode } from "../types.js";
import { validateKnowledgeGraph } from "../log.js";
import type { ApprovedDomain, DomainHierarchyEdge } from "./types.js";

export function validateDomainHierarchy(
  domains: ApprovedDomain[],
  hierarchy: DomainHierarchyEdge[],
  assignedDomainIds: Iterable<string> = [],
): void {
  const nodes = new Map<string, KnowledgeNode>(domains.map((domain) => [domain.id, {
    id: domain.id,
    kind: "domain",
    aliases: domain.aliases,
    revision: domain.revision,
    data: { ...domain },
  }]));
  const edges = new Map<string, KnowledgeEdge>(hierarchy.map((edge) => {
    const id = `subdomain-of:${edge.childId}->${edge.parentId}`;
    return [id, { id, kind: "subdomain-of", from: edge.childId, to: edge.parentId }];
  }));
  validateKnowledgeGraph({ nodes, edges });
  for (const domainId of assignedDomainIds) {
    const domain = domains.find((candidate) => candidate.id === domainId);
    if (!domain) throw new Error(`assignment references unknown domain ${domainId}`);
    if (!domain.assignable) throw new Error(`aggregate domain ${domainId} cannot own code`);
  }
}

export function editDomain(
  domain: ApprovedDomain,
  patch: Partial<Omit<ApprovedDomain, "id">> & { id?: string },
): ApprovedDomain {
  if (patch.id !== undefined && patch.id !== domain.id) throw new Error("domain id is immutable");
  const { id: _ignored, ...editable } = patch;
  return { ...domain, ...editable };
}
