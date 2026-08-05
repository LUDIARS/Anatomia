import { createHash } from "node:crypto";
import type { ApprovedDomain, DomainHierarchyEdge } from "./types.js";

export function contentHash(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function yamlString(value: string): string {
  return JSON.stringify(value.normalize("NFC"));
}

function yamlList(values: string[], indent = 2): string[] {
  const prefix = " ".repeat(indent);
  return values.length > 0 ? values.map((value) => `${prefix}- ${yamlString(value)}`) : [`${prefix}[]`];
}

export function renderDomainOkf(domain: ApprovedDomain, hierarchy: DomainHierarchyEdge[], service: string): string {
  const parent = hierarchy.find((edge) => edge.childId === domain.id)?.parentId;
  const lines = [
    "---",
    "type: data",
    `title: ${yamlString(domain.name)}`,
    `service: ${yamlString(service)}`,
    "status: implemented",
    "x-anatomia:",
    "  kind: domain",
    `  id: ${yamlString(domain.id)}`,
    `  assignable: ${domain.assignable}`,
  ];
  if (parent) lines.push(`  parent-id: ${yamlString(parent)}`);
  lines.push("---", "", `# ${domain.name}`, "", "## Purpose", "", domain.purpose, "", "## Responsibilities", "");
  lines.push(...yamlList(domain.responsibilities, 0));
  lines.push("", "## Boundary", "", "### In scope", "", ...yamlList(domain.boundary.inScope, 0));
  lines.push("", "### Out of scope", "", ...yamlList(domain.boundary.outOfScope, 0), "");
  return lines.join("\n").replace(/\r\n?/g, "\n");
}

export function domainOkfFileName(domainId: string): string {
  const readable = domainId.split("/").at(-1)?.replace(/[^A-Za-z0-9._~-]+/g, "-") || "domain";
  const digest = createHash("sha256").update(domainId, "utf8").digest("hex").slice(0, 10);
  return `${readable}-${digest}.md`;
}
