/** Render and persist human-approved orphan-domain specification drafts. */

import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OrphanDomainProposal } from "./orphan-proposals.js";

export interface ApprovedOrphanDomainProposal extends OrphanDomainProposal {
  /** Human correction/context appended before the draft becomes authoritative. */
  humanSupplement: string;
}

function bullets(items: string[], empty: string): string[] {
  return items.length ? items.map((item) => `- ${item}`) : [`- ${empty}`];
}

function specSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug) return slug;
  return createHash("sha256").update(name, "utf8").digest("hex").slice(0, 8);
}

export function approvedDomainSpecRelativePath(name: string): string {
  return `spec/feature/domain-${specSlug(name)}.md`;
}

export function renderApprovedDomainSpec(proposal: ApprovedOrphanDomainProposal): string {
  const humanSupplement = proposal.humanSupplement.trim();
  if (!humanSupplement) {
    throw new Error(`humanSupplement is required for domain "${proposal.domain.name}"`);
  }
  const evidence = proposal.evidence.map(
    (fn) => `- \`${fn.name}\` — \`${fn.file}:${fn.line}\` (end ${fn.endLine})`,
  );
  return [
    `# domain: ${proposal.spec.title}`,
    "",
    "## 目的",
    "",
    proposal.spec.purpose,
    "",
    "## 責務",
    "",
    ...bullets(proposal.spec.responsibilities, "要補足"),
    "",
    "## 範囲内",
    "",
    ...bullets(proposal.spec.inScope, "要補足"),
    "",
    "## 範囲外",
    "",
    ...bullets(proposal.spec.outOfScope, "要補足"),
    "",
    "## 依存と境界",
    "",
    ...bullets(proposal.spec.dependencies, "未特定"),
    "",
    "## 受入条件",
    "",
    ...bullets(proposal.spec.acceptanceCriteria, "人間が補足する"),
    "",
    "## 実装 evidence",
    "",
    ...evidence,
    "",
    "## 仮定",
    "",
    ...bullets(proposal.spec.assumptions, "なし"),
    "",
    "## 未決質問",
    "",
    ...bullets(proposal.spec.openQuestions, "なし"),
    "",
    "## 人間の補足",
    "",
    humanSupplement,
    "",
    "## Provenance",
    "",
    `- proposal: \`${proposal.proposalId}\``,
    `- orphan group: \`${proposal.groupId}\``,
    `- analysis snapshot: \`${proposal.snapshotId}\``,
    `- spec snapshot: \`${proposal.specSnapshotId}\``,
    "- origin: orphan-group / human-approved",
    "",
  ].join("\n");
}

/**
 * Save approved specs without overwriting a different existing document.
 * Re-applying byte-identical content is idempotent.
 */
export async function saveApprovedDomainSpecs(
  repoRoot: string,
  proposals: ApprovedOrphanDomainProposal[],
): Promise<string[]> {
  const prepared = proposals.map((proposal) => ({
    relativePath: approvedDomainSpecRelativePath(proposal.domain.name),
    content: renderApprovedDomainSpec(proposal),
  }));
  const uniquePaths = new Set<string>();
  for (const item of prepared) {
    if (uniquePaths.has(item.relativePath)) {
      throw new Error(`multiple approved domains resolve to ${item.relativePath}; rename one explicitly`);
    }
    uniquePaths.add(item.relativePath);
  }

  for (const item of prepared) {
    const path = join(repoRoot, ...item.relativePath.split("/"));
    try {
      const existing = await readFile(path, "utf8");
      if (existing !== item.content) {
        throw new Error(
          `refusing to overwrite existing domain spec ${item.relativePath}; merge or rename it explicitly`,
        );
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }

  await mkdir(join(repoRoot, "spec", "feature"), { recursive: true });
  const written: string[] = [];
  try {
    for (const item of prepared) {
      const path = join(repoRoot, ...item.relativePath.split("/"));
      try {
        await writeFile(path, item.content, { encoding: "utf8", flag: "wx" });
        written.push(item.relativePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readFile(path, "utf8");
        if (existing !== item.content) {
          throw new Error(`domain spec changed concurrently: ${item.relativePath}`);
        }
      }
    }
  } catch (error) {
    await Promise.all(
      written.map((relativePath) =>
        unlink(join(repoRoot, ...relativePath.split("/"))).catch(() => undefined),
      ),
    );
    throw error;
  }
  return written;
}
