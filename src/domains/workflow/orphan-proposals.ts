/**
 * LLM-backed proposals for large groups of domain-unassigned functions.
 *
 * The LLM may describe meaning and draft a specification, but it never supplies
 * source evidence. Membership paths and file:line locations are copied from the
 * deterministic investigation so a hallucinated symbol cannot become authority.
 */

import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { CacheStore } from "../../cache/store.js";
import { versionedKey } from "../../cache/store.js";
import type { SpecClause } from "../../types.js";
import type { DomainDraft } from "../authoring/types.js";
import type { LLMClient } from "../card.js";
import type {
  OrphanFeatureGroup,
  OrphanFunctionLocation,
  OrphanInvestigation,
} from "../discovery/index.js";

export const ORPHAN_PROPOSAL_PROMPT_VERSION = "2";

export interface GeneratedDomainSpecDraft {
  title: string;
  purpose: string;
  responsibilities: string[];
  inScope: string[];
  outOfScope: string[];
  dependencies: string[];
  acceptanceCriteria: string[];
  assumptions: string[];
  openQuestions: string[];
}

export interface OrphanDomainProposal {
  proposalId: string;
  snapshotId: string;
  specSnapshotId: string;
  groupId: string;
  origin: "orphan-group";
  domain: DomainDraft;
  spec: GeneratedDomainSpecDraft;
  evidence: readonly OrphanFunctionLocation[];
}

export type OrphanProposalCache = CacheStore<OrphanDomainProposal>;

interface LlmProposal {
  name: string;
  description: string;
  rationale: string;
  responsibilities: string[];
  inScope: string[];
  outOfScope: string[];
  dependencies: string[];
  acceptanceCriteria: string[];
  assumptions: string[];
  openQuestions: string[];
  specRefs: string[];
  mechanics: string[];
}

const MAX_SPEC_CLAUSES = 30;
const MAX_SPEC_TEXT = 320;

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function orphanSpecSnapshotId(specClauses: SpecClause[]): string {
  return stableHash(
    [...specClauses]
      .map((clause) => ({
        id: clause.id,
        heading: clause.heading,
        sourceFile: clause.sourceFile.replace(/\\/g, "/"),
        text: clause.text,
      }))
      .sort((a, b) => {
        const ak = `${a.sourceFile}\0${a.id}\0${a.heading}\0${a.text}`;
        const bk = `${b.sourceFile}\0${b.id}\0${b.heading}\0${b.text}`;
        return ak < bk ? -1 : ak > bk ? 1 : 0;
      }),
  );
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("orphan-domain LLM returned no JSON object");
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("response root must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`orphan-domain LLM returned malformed JSON: ${String(error)}`);
  }
}

function parseLlmProposal(raw: string): LlmProposal {
  const value = parseJsonObject(raw);
  const name = typeof value["name"] === "string" ? value["name"].trim() : "";
  const description =
    typeof value["description"] === "string" ? value["description"].trim() : "";
  if (!name || !description) {
    throw new Error("orphan-domain LLM response requires non-empty name and description");
  }
  return {
    name,
    description,
    rationale: typeof value["rationale"] === "string" ? value["rationale"].trim() : "",
    responsibilities: asStrings(value["responsibilities"]),
    inScope: asStrings(value["inScope"]),
    outOfScope: asStrings(value["outOfScope"]),
    dependencies: asStrings(value["dependencies"]),
    acceptanceCriteria: asStrings(value["acceptanceCriteria"]),
    assumptions: asStrings(value["assumptions"]),
    openQuestions: asStrings(value["openQuestions"]),
    specRefs: asStrings(value["specRefs"]),
    mechanics: asStrings(value["mechanics"]),
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build membership from server-owned evidence rather than the LLM response. */
export function membershipPatterns(group: OrphanFeatureGroup): string[] {
  const dirs = new Set<string>();
  for (const fn of group.functions) {
    const dir = posix.dirname(fn.file.replace(/\\/g, "/"));
    dirs.add(dir);
  }
  return [...dirs]
    .sort()
    .map((dir) =>
      dir === "." ? "^[^/]+$" : `(^|/)${escapeRegex(dir.replace(/^\.\//, ""))}/`,
    );
}

export function assembleOrphanProposalPrompt(
  group: OrphanFeatureGroup,
  specClauses: SpecClause[],
): string {
  const functions = group.functions
    .map((fn) => `- ${fn.name} :: ${fn.signature} (${fn.file}:${fn.line})`)
    .join("\n");
  const specs = [...specClauses]
    .sort((a, b) => {
      const ak = `${a.sourceFile}\0${a.heading}\0${a.id}`;
      const bk = `${b.sourceFile}\0${b.heading}\0${b.id}`;
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    })
    .slice(0, MAX_SPEC_CLAUSES)
    .map((clause) => {
      const text = clause.text.replace(/\s+/g, " ").trim().slice(0, MAX_SPEC_TEXT);
      return `- ${clause.heading} [${clause.id}]: ${text}`;
    })
    .join("\n");

  return [
    "You are investigating a structurally grouped set of functions that belongs to no",
    "approved domain. Decide whether this LARGE group forms one coherent domain and",
    "draft its specification. Do not invent source symbols or locations; the evidence",
    "below is authoritative. Return concise JSON only (no Markdown/code fence).",
    "",
    `GROUP: ${group.label} (${group.functionCount} functions, cohesion ${group.cohesion.toFixed(3)})`,
    functions,
    "",
    "EXISTING SPEC CONTEXT:",
    specs || "(none)",
    "",
    "JSON shape:",
    '{"name":"...","description":"...","rationale":"...",',
    ' "responsibilities":["..."],"inScope":["..."],"outOfScope":["..."],',
    ' "dependencies":["..."],"acceptanceCriteria":["..."],',
    ' "assumptions":["..."],"openQuestions":["..."],',
    ' "specRefs":["existing heading or id"],"mechanics":[]}',
  ].join("\n");
}

function knownSpecRefs(requested: string[], clauses: SpecClause[]): string[] {
  const known = new Set<string>();
  for (const clause of clauses) {
    known.add(clause.id);
    known.add(clause.heading);
  }
  return [...new Set(requested.filter((ref) => known.has(ref)))].sort();
}

async function proposeGroup(
  investigation: OrphanInvestigation,
  group: OrphanFeatureGroup,
  specClauses: SpecClause[],
  llm: LLMClient,
  cache: OrphanProposalCache | undefined,
  modelId: string,
): Promise<OrphanDomainProposal> {
  const specSnapshotId = orphanSpecSnapshotId(specClauses);
  const sourceKey = stableHash({
    snapshotId: investigation.snapshotId,
    groupId: group.groupId,
    specSnapshotId,
  });
  const cacheKey = versionedKey(sourceKey, modelId, ORPHAN_PROPOSAL_PROMPT_VERSION);
  const cached = await cache?.get(cacheKey);
  if (cached) return cached;

  const parsed = parseLlmProposal(await llm(assembleOrphanProposalPrompt(group, specClauses)));
  const domain: DomainDraft = {
    name: parsed.name,
    description: parsed.description,
    pathPatterns: membershipPatterns(group),
    namePatterns: [],
    specRefs: knownSpecRefs(parsed.specRefs, specClauses),
    mechanics: parsed.mechanics,
    rationale: parsed.rationale,
  };
  const spec: GeneratedDomainSpecDraft = {
    title: parsed.name,
    purpose: parsed.description,
    responsibilities: parsed.responsibilities,
    inScope: parsed.inScope,
    outOfScope: parsed.outOfScope,
    dependencies: parsed.dependencies,
    acceptanceCriteria: parsed.acceptanceCriteria,
    assumptions: parsed.assumptions,
    openQuestions: parsed.openQuestions,
  };
  const proposal: OrphanDomainProposal = {
    proposalId: stableHash({
      snapshotId: investigation.snapshotId,
      specSnapshotId,
      groupId: group.groupId,
      domain,
      spec,
    }),
    snapshotId: investigation.snapshotId,
    specSnapshotId,
    groupId: group.groupId,
    origin: "orphan-group",
    domain,
    spec,
    evidence: group.functions,
  };
  await cache?.set(cacheKey, proposal);
  return proposal;
}

/**
 * Propose domains for selected large groups. Unknown or non-candidate ids fail
 * fast so a caller cannot use the LLM endpoint to promote a small leftover.
 */
export async function synthesizeOrphanDomainProposals(
  investigation: OrphanInvestigation,
  specClauses: SpecClause[],
  llm: LLMClient,
  options: {
    groupIds?: string[];
    cache?: OrphanProposalCache;
    modelId?: string;
  } = {},
): Promise<OrphanDomainProposal[]> {
  const byId = new Map(investigation.candidateGroups.map((group) => [group.groupId, group]));
  const requested = options.groupIds?.length
    ? [...new Set(options.groupIds)].sort()
    : [...byId.keys()].sort();
  const groups = requested.map((groupId) => {
    const group = byId.get(groupId);
    if (!group) throw new Error(`unknown or non-candidate orphan group "${groupId}"`);
    return group;
  });
  const proposals: OrphanDomainProposal[] = [];
  for (const group of groups) {
    proposals.push(
      await proposeGroup(
        investigation,
        group,
        specClauses,
        llm,
        options.cache,
        options.modelId ?? "default",
      ),
    );
  }
  return proposals.sort((a, b) =>
    a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0,
  );
}
