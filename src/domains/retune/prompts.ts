/**
 * src/domains/retune/prompts.ts — Prompt builders for the LLM re-tune steps.
 *
 * Each builder produces a compact, deterministic prompt that asks for SHORT
 * strict JSON (no Markdown bodies). The expected JSON shape is stated inline so
 * the model returns exactly what callLlmJson can parse.
 *
 * SRP: string construction only. No LLM calls (llm.ts), no step logic (steps.ts).
 */

import type { DirStat, DomainPlan, DomainReviewSummary } from "./types.js";

/** Skeleton a step-1 prompt produces (domains + conceptual module hints). */
export interface DomainSkeleton {
  name: string;
  description: string;
  moduleHints: { name: string; description: string }[];
}

const JSON_ONLY = "Return ONLY JSON (no prose, no code fence).";

function dirLine(d: DirStat): string {
  return `- ${d.dir}  (${d.nodeCount} fns, weight ${d.totalSize}; e.g. ${d.representatives.join(", ")})`;
}

/** Step 1 — decide domains + big modules from purpose + spec + dir candidates. */
export function step1Prompt(input: {
  project: string;
  purpose: string;
  specHeadings: string[];
  dirs: DirStat[];
  /** Auto-detected UI screen composition (screens/ layer), when present. */
  screens?: string[];
}): string {
  const screenSection =
    input.screens && input.screens.length
      ? [
          ``,
          `## Detected UI screens (auto-learned screen composition)`,
          `Consider whether a screen/UI-flow domain belongs in the taxonomy.`,
          input.screens.slice(0, 30).join("\n"),
        ]
      : [];
  return [
    `You are designing the DOMAIN taxonomy for the codebase "${input.project}".`,
    `A "domain" is a top-level purpose area (what the code is FOR). A "module" is a`,
    `cohesive sub-area inside a domain. Base the taxonomy on the project's PURPOSE`,
    `and its spec, not on incidental file layout.`,
    ``,
    `## Purpose (README/DESIGN excerpt)`,
    input.purpose.slice(0, 3000),
    ``,
    `## spec/feature headings`,
    input.specHeadings.slice(0, 60).map((h) => `- ${h}`).join("\n"),
    ``,
    `## Source directories (module candidates, heaviest first)`,
    input.dirs.slice(0, 40).map(dirLine).join("\n"),
    ...screenSection,
    ``,
    `Decide 4–8 domains, each with 1–4 module hints. Use concise kebab-case names.`,
    `${JSON_ONLY} Shape:`,
    `{"domains":[{"name":"...","description":"...","moduleHints":[{"name":"...","description":"..."}]}]}`,
  ].join("\n");
}

/** Step 2 — assign each directory to a (domain, module) from the skeleton. */
export function step2Prompt(input: { domains: DomainSkeleton[]; dirs: DirStat[] }): string {
  const skeleton = input.domains
    .map(
      (d) =>
        `- domain "${d.name}": ${d.description}\n  modules: ${d.moduleHints
          .map((m) => `${m.name} (${m.description})`)
          .join("; ")}`,
    )
    .join("\n");
  return [
    `Assign each source directory of the codebase to the BEST-FIT domain + module`,
    `from the taxonomy skeleton below. If a directory does not clearly fit any`,
    `module, set "module" to "" (it will be handled separately). You MAY introduce`,
    `a new module name under an existing domain when a directory clearly belongs to`,
    `the domain but no listed module fits.`,
    ``,
    `## Taxonomy skeleton`,
    skeleton,
    ``,
    `## Directories`,
    input.dirs.map(dirLine).join("\n"),
    ``,
    `${JSON_ONLY} Shape:`,
    `{"assignments":[{"dir":"src/...","domain":"...","module":"...","confidence":0.0}]}`,
  ].join("\n");
}

/** Step 3 — group leftover (unassigned) directories into new modules. */
export function step3Prompt(input: {
  domains: DomainSkeleton[];
  leftovers: DirStat[];
}): string {
  return [
    `These source directories were NOT confidently assigned to any module:`,
    input.leftovers.map(dirLine).join("\n"),
    ``,
    `Existing domains: ${input.domains.map((d) => d.name).join(", ")}.`,
    ``,
    `Propose new modules that GROUP these leftover directories (a module may cover`,
    `several related directories). Attach each new module to an existing domain when`,
    `it fits, else to a new domain named "misc" (or a better umbrella). Do not leave`,
    `a directory out — every leftover directory must land in exactly one module.`,
    ``,
    `${JSON_ONLY} Shape:`,
    `{"groups":[{"domain":"...","module":"...","description":"...","dirs":["src/..."]}]}`,
  ].join("\n");
}

/**
 * Deterministic domain-review evidence lines for the named domains: per-domain
 * cohesion/coupling ratio, boundary-drift findings and overlaps. Empty when the
 * review has nothing to say about those domains (no section emitted).
 */
export function reviewEvidenceSection(
  review: DomainReviewSummary | undefined,
  domainNames: string[],
): string[] {
  if (!review) return [];
  const want = new Set(domainNames);
  const lines: string[] = [];
  for (const d of review.domains) {
    if (!want.has(d.domain)) continue;
    const coh = d.cohesion === null ? "n/a" : d.cohesion.toFixed(2);
    lines.push(
      `- domain "${d.domain}": cohesion ${coh} (internal ${d.internalEdges} / boundary ${d.boundaryEdges} calls edges)`,
    );
  }
  for (const f of review.boundaryDrift) {
    if (!want.has(f.domain) && !want.has(f.suggested)) continue;
    const votes = f.votes.map((v) => `${v.domain}:${v.count}`).join(", ");
    lines.push(
      `- boundary drift: ${f.name} (${f.file}:${f.line}) assigned=${f.domain} neighbours-suggest=${f.suggested} (votes ${votes})`,
    );
  }
  for (const o of review.overlap) {
    if (!o.domains.some((x) => want.has(x))) continue;
    lines.push(`- overlap: ${o.name} (${o.file}:${o.line}) claimed by [${o.domains.join(", ")}]`);
  }
  if (lines.length === 0) return [];
  return [
    ``,
    `## Domain review evidence (deterministic structural review)`,
    `Use these measured facts when deciding:`,
    ...lines,
  ];
}

/** Step 5 — split an over-large domain (too many modules) into sub-domains. */
export function step5Prompt(input: { domain: DomainPlan; review?: DomainReviewSummary }): string {
  const mods = input.domain.modules
    .map((m) => `- ${m.name}: ${m.description} [paths: ${m.paths.join(", ")}]`)
    .join("\n");
  return [
    `The domain "${input.domain.name}" has ${input.domain.modules.length} modules,`,
    `which is too many for one domain. Split it into 2–3 cohesive sub-domains,`,
    `partitioning its modules (every module goes to exactly one sub-domain).`,
    ``,
    `## Modules`,
    mods,
    ...reviewEvidenceSection(input.review, [input.domain.name]),
    ``,
    `${JSON_ONLY} Shape:`,
    `{"subdomains":[{"name":"...","description":"...","modules":["moduleName"]}]}`,
  ].join("\n");
}

/** Step 6 — merge too many tiny modules. */
export function step6Prompt(input: {
  smallModules: { name: string; domain: string; nodeCount: number; description: string }[];
  review?: DomainReviewSummary;
}): string {
  const list = input.smallModules
    .map((m) => `- ${m.name} (domain ${m.domain}, ${m.nodeCount} fns): ${m.description}`)
    .join("\n");
  const domains = [...new Set(input.smallModules.map((m) => m.domain))].sort();
  return [
    `These modules are very small (few functions each). Propose merges that combine`,
    `related tiny modules into a single larger module. Only merge modules that are`,
    `genuinely related; leave a module alone (omit it) if no good merge exists.`,
    `Merge only WITHIN the same domain.`,
    ``,
    `## Small modules`,
    list,
    ...reviewEvidenceSection(input.review, domains),
    ``,
    `${JSON_ONLY} Shape:`,
    `{"merges":[{"domain":"...","into":"newOrExistingModuleName","description":"...","modules":["a","b"]}]}`,
  ].join("\n");
}
