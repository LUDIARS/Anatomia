import { addDir, emptyTaxonomy, findOrCreateDomain, findOrCreateModule, kebab } from "../retune/taxonomy-ops.js";
import { loadTaxonomy, saveTaxonomy } from "../retune/taxonomy-store.js";
import type { ModulePlan, Taxonomy } from "../retune/types.js";

export interface DomainOrganizationSpecInput {
  id?: string;
  title?: string;
  path?: string;
  text: string;
}

export interface DomainOrganizationAnswer {
  questionId: string;
  answer: string;
}

export interface ExistingDomainInput {
  name: string;
  description?: string | null;
}

export interface DomainOrganizationInput {
  project?: string;
  serviceName?: string;
  serviceDescription?: string;
  specs?: DomainOrganizationSpecInput[];
  existingDomains?: ExistingDomainInput[];
  uxAnswers?: DomainOrganizationAnswer[];
  generatedAt?: string;
}

export interface DomainOrganizationEdits {
  domains?: Array<{
    match: string;
    name?: string;
    slug?: string;
    description?: string;
    userPromise?: string;
    responsibilities?: string[];
    boundaries?: string[];
    moduleName?: string;
    pathHints?: string[];
    nameHints?: string[];
    entrypointHints?: string[];
    drop?: boolean;
  }>;
  specs?: Array<{
    code: string;
    title?: string;
    targetDomain?: string;
    body?: string;
    acceptance?: string[];
    drop?: boolean;
  }>;
}

export type DomainOrganizationQuestionKind =
  | "service-actor"
  | "service-success"
  | "domain-boundary"
  | "domain-success"
  | "machine-boundary"
  | "spec-gap";

export interface DomainOrganizationQuestion {
  id: string;
  kind: DomainOrganizationQuestionKind;
  severity: "required" | "recommended";
  domain?: string;
  question: string;
  why: string;
  answerShape: string[];
}

export interface DomainSpecRef {
  specId: string;
  title: string;
  path: string | null;
  heading: string;
}

export interface DomainOrganizationPlan {
  name: string;
  slug: string;
  description: string;
  userPromise: string;
  responsibilities: string[];
  boundaries: string[];
  uxDecisions: Array<{ questionId: string; answer: string }>;
  specRefs: DomainSpecRef[];
  unresolvedQuestions: string[];
  machine: {
    moduleName: string;
    pathHints: string[];
    nameHints: string[];
    entrypointHints: string[];
  };
}

export interface ReadableSpecDraft {
  code: string;
  title: string;
  targetDomain: string;
  body: string;
  acceptance: string[];
  unresolvedQuestionIds: string[];
}

export interface DomainMachineConfiguration {
  canonicalSource: "human-authored-domain-definitions";
  anatomia: {
    ontologyDir: "spec/data/ontology";
    domainDefs: Array<{
      name: string;
      description: string;
      membership: Array<{ pathPattern?: string; namePattern?: string }>;
      source: "manual";
      lockedFields: ["description"];
      specRefs: string[];
      mechanics: string[];
    }>;
  };
}

export interface DomainOrganizationResult {
  project: string;
  serviceName: string;
  generatedAt: string;
  mode: "human-domain-organization";
  source: {
    serviceDescriptionPresent: boolean;
    specCount: number;
    existingDomainCount: number;
    answeredQuestionCount: number;
  };
  questions: DomainOrganizationQuestion[];
  domains: DomainOrganizationPlan[];
  readableSpecs: ReadableSpecDraft[];
  machineConfiguration: DomainMachineConfiguration;
  handoff: {
    anatomia: string[];
    praeforma: string[];
    melpomeneAugur: string[];
  };
}

export interface ApplyDomainOrganizationReport {
  project: string;
  domains: Array<{ name: string; action: "created" | "updated" }>;
  removedDomains: string[];
  modules: Array<{ domain: string; name: string; action: "created" | "updated" }>;
  paths: Array<{ domain: string; module: string; path: string; action: "added" | "present" }>;
  names: Array<{ domain: string; module: string; pattern: string; action: "added" | "present" }>;
  warnings: string[];
  taxonomy: Taxonomy;
  written: string[];
  ontologyDir: string;
}

export interface ApplyDomainOrganizationOptions {
  removeDomains?: string[];
}

interface SpecSection {
  specId: string;
  specTitle: string;
  path: string | null;
  heading: string;
  text: string;
}

interface DomainSeed {
  name: string;
  description?: string | null;
  sections: SpecSection[];
}

const GENERIC_HEADINGS = new Set([
  "overview",
  "summary",
  "background",
  "purpose",
  "goals",
  "requirements",
  "spec",
  "specification",
  "api",
  "interface",
  "notes",
  "todo",
]);

export function buildDomainOrganization(input: DomainOrganizationInput): DomainOrganizationResult {
  const specs = input.specs ?? [];
  const answers = answerMap(input.uxAnswers ?? []);
  const serviceName = clean(input.serviceName) || clean(input.project) || "service";
  const project = clean(input.project) || slug(serviceName);
  const sections = specs.flatMap((spec, index) => extractSections(spec, index));
  const seeds = buildDomainSeeds(input.existingDomains ?? [], sections, serviceName);
  const domains = seeds.map((seed) => buildDomainPlan(seed, serviceName, input.serviceDescription, answers));
  const questions = buildQuestions(input, domains, answers);
  const readableSpecs = domains.map((domain, index) => buildReadableSpec(domain, index, serviceName, answers));
  const machineConfiguration = buildMachineConfiguration(domains);

  return {
    project,
    serviceName,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    mode: "human-domain-organization",
    source: {
      serviceDescriptionPresent: Boolean(clean(input.serviceDescription)),
      specCount: specs.length,
      existingDomainCount: input.existingDomains?.length ?? 0,
      answeredQuestionCount: answers.size,
    },
    questions,
    domains,
    readableSpecs,
    machineConfiguration,
    handoff: {
      anatomia: [
        "Keep this taxonomy in spec/data/<project>.taxonomy.json.",
        "Regenerate spec/data/ontology domain definitions from the taxonomy.",
        "Use path/name hints as implementation evidence, not as the source of domain names.",
      ],
      praeforma: [
        "Use readableSpecs as the human-readable contract when Praeforma consumes this output.",
        "Keep Praeforma target domains aligned with the domain names returned here.",
      ],
      melpomeneAugur: [
        "Generate tests only after required UX questions are answered.",
        "Use readableSpecs as expected behavior and Anatomia anchors as implementation targets.",
      ],
    },
  };
}

export function buildDomainOrganizationPrompt(
  input: DomainOrganizationInput,
  draft = buildDomainOrganization(input),
): string {
  const lines = [
    "You are Anatomia, organizing human-owned domain boundaries.",
    "Turn service language and specification documents into a domain taxonomy.",
    "Do not invent top-level domains from code structure alone; humans own domain names and promises.",
    "Use machine analysis only for implementation assignment hints.",
    "",
    "Return JSON with the same shape as this draft. Improve wording and boundaries only when specs justify it.",
    "Keep unresolved decisions as questions instead of guessing.",
    "",
    "Service description:",
    input.serviceDescription?.trim() || "(missing)",
    "",
    "Input specs:",
    ...(input.specs ?? []).map((spec, index) => {
      const title = clean(spec.title) || clean(spec.path) || `spec-${index + 1}`;
      return `--- ${title}\n${spec.text.trim()}`;
    }),
    "",
    "Current deterministic draft JSON:",
    JSON.stringify(draft, null, 2),
  ];
  return lines.join("\n");
}

export function applyDomainOrganizationEdits(
  design: DomainOrganizationResult,
  edits?: DomainOrganizationEdits | null,
): DomainOrganizationResult {
  if (!edits) return design;
  const next = cloneDesign(design);

  for (const edit of edits.domains ?? []) {
    const index = next.domains.findIndex((domain) => matchesDomain(domain, edit.match));
    if (index < 0) continue;
    if (edit.drop) {
      const [removed] = next.domains.splice(index, 1);
      if (removed) next.readableSpecs = next.readableSpecs.filter((spec) => !sameName(spec.targetDomain, removed.name));
      continue;
    }
    const domain = next.domains[index]!;
    const oldName = domain.name;
    if (edit.name) domain.name = clean(edit.name);
    if (edit.slug) domain.slug = slug(edit.slug);
    else if (edit.name) domain.slug = slug(edit.name);
    if (edit.description !== undefined) domain.description = edit.description;
    if (edit.userPromise !== undefined) domain.userPromise = edit.userPromise;
    if (edit.responsibilities) domain.responsibilities = edit.responsibilities;
    if (edit.boundaries) domain.boundaries = edit.boundaries;
    if (edit.moduleName) domain.machine.moduleName = slug(edit.moduleName);
    else if (edit.name) domain.machine.moduleName = domain.slug;
    if (edit.pathHints) domain.machine.pathHints = unique(edit.pathHints.map(clean).filter(Boolean));
    if (edit.nameHints) domain.machine.nameHints = unique(edit.nameHints.map(clean).filter(Boolean));
    if (edit.entrypointHints) domain.machine.entrypointHints = unique(edit.entrypointHints.map(clean).filter(Boolean));
    for (const spec of next.readableSpecs) {
      if (sameName(spec.targetDomain, oldName)) spec.targetDomain = domain.name;
    }
  }

  for (const edit of edits.specs ?? []) {
    const index = next.readableSpecs.findIndex((spec) => spec.code === edit.code);
    if (index < 0) continue;
    if (edit.drop) {
      next.readableSpecs.splice(index, 1);
      continue;
    }
    const spec = next.readableSpecs[index]!;
    if (edit.title !== undefined) spec.title = edit.title;
    if (edit.targetDomain !== undefined) spec.targetDomain = edit.targetDomain;
    if (edit.body !== undefined) spec.body = edit.body;
    if (edit.acceptance !== undefined) spec.acceptance = edit.acceptance;
  }

  next.machineConfiguration = buildMachineConfiguration(next.domains);
  next.source = { ...next.source };
  return next;
}

export async function applyDomainOrganization(
  repoPath: string,
  project: string,
  design: DomainOrganizationResult,
  options: ApplyDomainOrganizationOptions = {},
): Promise<ApplyDomainOrganizationReport> {
  const taxonomy = (await loadTaxonomy(repoPath, project)) ?? emptyTaxonomy(project);
  const warnings: string[] = [];
  const domains: ApplyDomainOrganizationReport["domains"] = [];
  const removedDomains = removeRequestedDomains(taxonomy, options.removeDomains ?? []);
  const modules: ApplyDomainOrganizationReport["modules"] = [];
  const paths: ApplyDomainOrganizationReport["paths"] = [];
  const names: ApplyDomainOrganizationReport["names"] = [];

  for (const domain of design.domains) {
    const domainId = kebab(domain.slug || domain.name);
    const existedDomain = taxonomy.domains.some((item) => item.name === domainId);
    const plan = findOrCreateDomain(taxonomy, domainId, domain.description);
    plan.description = domain.description || plan.description;
    domains.push({ name: plan.name, action: existedDomain ? "updated" : "created" });

    const moduleName = domain.machine.moduleName || domain.slug || domain.name;
    const moduleId = kebab(moduleName);
    const existedModule = plan.modules.some((item) => item.name === moduleId);
    const module = findOrCreateModule(plan, moduleId, domain.description);
    module.description = domain.description || module.description;
    modules.push({ domain: plan.name, name: module.name, action: existedModule ? "updated" : "created" });

    const dirs = unique(domain.machine.pathHints.map(pathHintToAnatomiaDir).filter((dir): dir is string => Boolean(dir)));
    if (dirs.length === 0) warnings.push(`${plan.name}/${module.name}: no path hints could be converted to taxonomy dirs`);
    for (const dir of dirs) {
      const before = module.paths.length;
      addDir(module, dir);
      paths.push({
        domain: plan.name,
        module: module.name,
        path: dir,
        action: module.paths.length > before ? "added" : "present",
      });
    }

    for (const pattern of unique(domain.machine.nameHints.map(clean).filter(Boolean))) {
      const action = addNamePattern(module, pattern);
      names.push({ domain: plan.name, module: module.name, pattern, action });
    }
  }

  const result = await saveTaxonomy(repoPath, taxonomy);
  return {
    project,
    domains,
    removedDomains,
    modules,
    paths,
    names,
    warnings,
    taxonomy,
    written: result.written,
    ontologyDir: result.ontologyDir,
  };
}

function removeRequestedDomains(taxonomy: Taxonomy, names: string[]): string[] {
  const ids = new Set(names.map((name) => kebab(name)).filter(Boolean));
  if (ids.size === 0) return [];
  const removed: string[] = [];
  taxonomy.domains = taxonomy.domains.filter((domain) => {
    if (!ids.has(kebab(domain.name))) return true;
    removed.push(domain.name);
    return false;
  });
  return removed;
}

export function pathHintToAnatomiaDir(hint: string): string | null {
  let value = hint.trim();
  value = value.replace(/^\(\^\|\/\)/, "");
  value = value.replace(/\(\/\|\$\).*$/, "");
  value = value.replace(/\/\[\^\/\]\+\$$/, "");
  value = value.replace(/\\([/._-])/g, "$1");
  if (!/^(src|app|packages|lib|server|client|web)\//.test(value)) return null;
  return value.replace(/\/+$/, "");
}

export function domainHasRequiredAnswers(domain: DomainOrganizationPlan): boolean {
  return !domain.unresolvedQuestions.some((id) => id === "service:actor" || id === "service:success" || id.includes(":domain-"));
}

export function specHasRequiredAnswers(spec: ReadableSpecDraft): boolean {
  return spec.unresolvedQuestionIds.length === 0;
}

function buildDomainSeeds(existingDomains: ExistingDomainInput[], sections: SpecSection[], serviceName: string): DomainSeed[] {
  const seeds = new Map<string, DomainSeed>();
  for (const domain of existingDomains) {
    const name = clean(domain.name);
    if (!name) continue;
    seeds.set(normalizeName(name), { name, description: domain.description ?? null, sections: [] });
  }

  for (const section of sections) {
    const name = inferDomainName(section.heading) || inferDomainName(section.specTitle);
    if (!name) continue;
    const key = normalizeName(name);
    const seed = seeds.get(key) ?? { name, sections: [] };
    seed.sections.push(section);
    seeds.set(key, seed);
  }

  if (seeds.size === 0) {
    seeds.set(normalizeName(serviceName), { name: `${serviceName} Core`, sections });
  }

  const out = [...seeds.values()];
  for (const section of sections) {
    if (out.some((seed) => seed.sections.includes(section))) continue;
    bestSeed(out, section).sections.push(section);
  }
  return out.slice(0, 8);
}

function buildDomainPlan(
  seed: DomainSeed,
  serviceName: string,
  serviceDescription: string | undefined,
  answers: Map<string, string>,
): DomainOrganizationPlan {
  const slugName = slug(seed.name);
  const boundaryAnswer = answers.get(domainQuestionId(slugName, "domain-boundary"));
  const successAnswer = answers.get(domainQuestionId(slugName, "domain-success"));
  const machineAnswer = answers.get(domainQuestionId(slugName, "machine-boundary"));
  const description =
    clean(seed.description) ||
    boundaryAnswer ||
    `${seed.name} represents a user-facing domain boundary in ${serviceName}.`;
  const userPromise =
    successAnswer ||
    summarize(seed.sections.map((section) => section.text).join("\n")) ||
    clean(serviceDescription) ||
    `${seed.name} records an observable user outcome.`;
  const responsibilities = inferResponsibilities(seed);
  const boundaries = boundaryAnswer
    ? [boundaryAnswer]
    : [`Own user actions, state changes, and visible outcomes directly related to ${seed.name}.`];
  const pathHints = inferPathHints(seed, slugName, machineAnswer);
  const nameHints = inferNameHints(seed.name, seed.sections, machineAnswer);
  const entrypointHints = inferEntrypointHints(seed.sections);
  const specRefs = seed.sections.map((section) => ({
    specId: section.specId,
    title: section.specTitle,
    path: section.path,
    heading: section.heading,
  }));
  const uxDecisions = [
    ["service:actor", answers.get("service:actor")],
    ["service:success", answers.get("service:success")],
    [domainQuestionId(slugName, "domain-boundary"), boundaryAnswer],
    [domainQuestionId(slugName, "domain-success"), successAnswer],
    [domainQuestionId(slugName, "machine-boundary"), machineAnswer],
  ]
    .filter((item): item is [string, string] => Boolean(item[1]))
    .map(([questionId, answer]) => ({ questionId, answer }));
  const unresolvedQuestions = [
    !answers.has("service:actor") ? "service:actor" : null,
    !answers.has("service:success") ? "service:success" : null,
    !boundaryAnswer ? domainQuestionId(slugName, "domain-boundary") : null,
    !successAnswer ? domainQuestionId(slugName, "domain-success") : null,
  ].filter((id): id is string => Boolean(id));

  return {
    name: seed.name,
    slug: slugName,
    description,
    userPromise,
    responsibilities,
    boundaries,
    uxDecisions,
    specRefs,
    unresolvedQuestions,
    machine: {
      moduleName: slugName,
      pathHints,
      nameHints,
      entrypointHints,
    },
  };
}

function buildQuestions(
  input: DomainOrganizationInput,
  domains: DomainOrganizationPlan[],
  answers: Map<string, string>,
): DomainOrganizationQuestion[] {
  const questions: DomainOrganizationQuestion[] = [];
  if (!clean(input.serviceDescription)) {
    questions.push({
      id: "service:description",
      kind: "spec-gap",
      severity: "required",
      question: "What user, problem, and observable outcome does this service own?",
      why: "Domain boundaries need the service intent before implementation hints can be trusted.",
      answerShape: ["target user", "problem being solved", "observable outcome"],
    });
  }
  if (!answers.has("service:actor")) {
    questions.push({
      id: "service:actor",
      kind: "service-actor",
      severity: "required",
      question: "Who is the primary user or actor, and where do they enter the workflow?",
      why: "Top-level domains should follow user intent, not only directory layout.",
      answerShape: ["user or actor", "entry point", "starting state"],
    });
  }
  if (!answers.has("service:success")) {
    questions.push({
      id: "service:success",
      kind: "service-success",
      severity: "required",
      question: "What observable state means the service succeeded?",
      why: "Each domain needs a clear success condition for specs and tests.",
      answerShape: ["screen/state change", "saved data", "notification or visible result"],
    });
  }

  for (const domain of domains) {
    if (!answers.has(domainQuestionId(domain.slug, "domain-boundary"))) {
      questions.push({
        id: domainQuestionId(domain.slug, "domain-boundary"),
        kind: "domain-boundary",
        severity: "required",
        domain: domain.name,
        question: `What is inside and outside the ${domain.name} domain?`,
        why: "Anatomia uses this human boundary when assigning implementation evidence.",
        answerShape: ["included experience", "excluded experience", "neighboring domains"],
      });
    }
    if (!answers.has(domainQuestionId(domain.slug, "domain-success"))) {
      questions.push({
        id: domainQuestionId(domain.slug, "domain-success"),
        kind: "domain-success",
        severity: "required",
        domain: domain.name,
        question: `How can a user tell that ${domain.name} succeeded?`,
        why: "Readable specs and generated tests need an observable outcome.",
        answerShape: ["observable result", "saved data or state", "failure contrast"],
      });
    }
    const fallbackPath = `(^|/)src/${domain.slug}(/|$)`;
    const onlyFallback =
      domain.machine.pathHints.length === 1 &&
      domain.machine.pathHints[0] === fallbackPath &&
      domain.machine.nameHints.length === 0;
    if (!answers.has(domainQuestionId(domain.slug, "machine-boundary")) && onlyFallback) {
      questions.push({
        id: domainQuestionId(domain.slug, "machine-boundary"),
        kind: "machine-boundary",
        severity: "recommended",
        domain: domain.name,
        question: `Which code directories, names, or entry points likely implement ${domain.name}?`,
        why: "Anatomia can map the human domain faster with initial machine hints.",
        answerShape: ["directory", "function/class name tokens", "screen or entry point"],
      });
    }
  }
  return questions;
}

function buildReadableSpec(
  domain: DomainOrganizationPlan,
  index: number,
  serviceName: string,
  answers: Map<string, string>,
): ReadableSpecDraft {
  const code = `UX-${String(index + 1).padStart(3, "0")}-${domain.slug.toUpperCase().replace(/-/g, "_")}`;
  const actor = answers.get("service:actor") ?? "The target user";
  const serviceSuccess = answers.get("service:success") ?? "The service success state is not yet specified.";
  const acceptance = [
    `${actor} can identify the entry point for ${domain.name}.`,
    domain.userPromise,
    `${domain.name} has an observable success state in UI, stored data, or notification output.`,
  ];
  const body = [
    `# ${code}: ${domain.name}`,
    "",
    "## Service",
    serviceName,
    "",
    "## UX intent",
    domain.userPromise,
    "",
    "## Target user",
    actor,
    "",
    "## Domain boundary",
    ...domain.boundaries.map((item) => `- ${item}`),
    "",
    "## Responsibilities",
    ...domain.responsibilities.map((item) => `- ${item}`),
    "",
    "## Acceptance",
    ...acceptance.map((item) => `- ${item}`),
    "",
    "## Machine mapping",
    `- Anatomia domain: ${domain.slug}`,
    `- Path hints: ${domain.machine.pathHints.join(", ") || "(none yet)"}`,
    `- Name hints: ${domain.machine.nameHints.join(", ") || "(none yet)"}`,
    "",
    "## Service success context",
    serviceSuccess,
  ].join("\n");

  return {
    code,
    title: `${domain.name} UX`,
    targetDomain: domain.name,
    body,
    acceptance,
    unresolvedQuestionIds: domain.unresolvedQuestions,
  };
}

export function buildMachineConfiguration(domains: DomainOrganizationPlan[]): DomainMachineConfiguration {
  return {
    canonicalSource: "human-authored-domain-definitions",
    anatomia: {
      ontologyDir: "spec/data/ontology",
      domainDefs: domains.map((domain) => ({
        name: domain.slug,
        description: domain.description,
        membership: [
          ...domain.machine.pathHints.map((pathPattern) => ({ pathPattern })),
          ...domain.machine.nameHints.map((namePattern) => ({ namePattern })),
        ],
        source: "manual",
        lockedFields: ["description"],
        specRefs: domain.specRefs.map((ref) => `${ref.specId}:${ref.heading}`),
        mechanics: domain.machine.entrypointHints,
      })),
    },
  };
}

function extractSections(spec: DomainOrganizationSpecInput, index: number): SpecSection[] {
  const specId = clean(spec.id) || clean(spec.path) || `spec-${index + 1}`;
  const specTitle = clean(spec.title) || clean(spec.path) || `Spec ${index + 1}`;
  const lines = spec.text.split(/\r?\n/);
  const sections: SpecSection[] = [];
  let current: { heading: string; body: string[] } | null = null;

  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (heading) {
      if (current) sections.push(sectionFrom(current, specId, specTitle, spec.path ?? null));
      current = { heading: clean(heading[2]) || specTitle, body: [] };
      continue;
    }
    if (!current) current = { heading: specTitle, body: [] };
    current.body.push(line);
  }

  if (current) sections.push(sectionFrom(current, specId, specTitle, spec.path ?? null));
  return sections.length > 0 ? sections : [{ specId, specTitle, path: spec.path ?? null, heading: specTitle, text: spec.text }];
}

function sectionFrom(
  current: { heading: string; body: string[] },
  specId: string,
  specTitle: string,
  path: string | null,
): SpecSection {
  return {
    specId,
    specTitle,
    path,
    heading: current.heading,
    text: current.body.join("\n").trim(),
  };
}

function inferDomainName(raw: string): string | null {
  const heading = clean(raw)
    .replace(/^feature\s*[:.-]\s*/i, "")
    .replace(/^domain\s*[:.-]\s*/i, "")
    .replace(/^ux\s*[:.-]\s*/i, "")
    .replace(/^\d+[\).:-]\s*/, "")
    .replace(/["']/g, "")
    .trim();
  if (!heading) return null;
  if (GENERIC_HEADINGS.has(heading.toLowerCase())) return null;
  const withoutSuffix = heading.replace(/\s+(requirements?|specification|spec|overview)$/i, "").trim();
  if (!withoutSuffix) return null;
  if (/^[A-Za-z0-9 _/-]+$/.test(withoutSuffix)) {
    return titleCase(withoutSuffix.split(/[\s_/-]+/).filter(Boolean).slice(0, 4).join(" "));
  }
  return withoutSuffix.length > 32 ? withoutSuffix.slice(0, 32) : withoutSuffix;
}

function inferResponsibilities(seed: DomainSeed): string[] {
  const bullets = seed.sections.flatMap((section) => extractBullets(section.text)).slice(0, 4);
  if (bullets.length > 0) return bullets;
  return [
    `Accept user actions related to ${seed.name}.`,
    `Expose success and failure states for ${seed.name}.`,
  ];
}

function inferPathHints(seed: DomainSeed, slugName: string, extraText = ""): string[] {
  const hints = new Set<string>();
  const raw = `${seed.sections.map((section) => section.text).join("\n")}\n${extraText}`;
  const pathRe = /(?:^|[\s(["'`])((?:src|app|packages|lib|server|client|web)\/[A-Za-z0-9._/-]+)/g;
  for (const match of raw.matchAll(pathRe)) {
    if (match[1]) hints.add(regexPath(match[1]));
  }
  hints.add(`(^|/)src/${escapeRegExp(slugName)}(/|$)`);
  return [...hints].slice(0, 5);
}

function inferNameHints(name: string, sections: SpecSection[], extraText = ""): string[] {
  const words = new Set(
    name
      .normalize("NFKC")
      .split(/[^A-Za-z0-9]+/)
      .filter((word) => word.length >= 3)
      .map(escapeRegExp),
  );
  for (const section of sections) {
    for (const token of section.heading.split(/[^A-Za-z0-9]+/)) {
      if (token.length >= 3) words.add(escapeRegExp(token));
    }
  }
  for (const token of extraText.split(/[^A-Za-z0-9]+/)) {
    if (token.length >= 3) words.add(escapeRegExp(token));
  }
  if (words.size === 0) return [];
  return [`(${[...words].slice(0, 6).join("|")})`];
}

function inferEntrypointHints(sections: SpecSection[]): string[] {
  return sections
    .filter((section) => /(start|entry|screen|page|route|endpoint|handler)/i.test(`${section.heading}\n${section.text}`))
    .map((section) => section.heading)
    .slice(0, 4);
}

function extractBullets(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1] ?? "")
    .map(clean)
    .filter(Boolean)
    .slice(0, 6);
}

function summarize(text: string): string {
  const first = text
    .replace(/\s+/g, " ")
    .split(/[.!?]/)
    .map(clean)
    .find((sentence) => sentence.length >= 12);
  return first ? (first.length > 120 ? `${first.slice(0, 120)}...` : first) : "";
}

function bestSeed(seeds: DomainSeed[], section: SpecSection): DomainSeed {
  let best = seeds[0];
  let bestScore = -1;
  for (const seed of seeds) {
    const score = overlapScore(seed.name, `${section.heading} ${section.text}`);
    if (score > bestScore) {
      best = seed;
      bestScore = score;
    }
  }
  return best ?? { name: "Service Core", sections: [] };
}

function overlapScore(name: string, text: string): number {
  const haystack = normalizeName(text);
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length >= 3)
    .reduce((score, word) => score + (haystack.includes(normalizeName(word)) ? 1 : 0), 0);
}

function answerMap(answers: DomainOrganizationAnswer[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const answer of answers) {
    const id = clean(answer.questionId);
    const value = clean(answer.answer);
    if (id && value) out.set(id, value);
  }
  return out;
}

function addNamePattern(module: ModulePlan, pattern: string): "added" | "present" {
  module.names ??= [];
  if (module.names.includes(pattern)) return "present";
  module.names.push(pattern);
  return "added";
}

function domainQuestionId(domainSlug: string, kind: "domain-boundary" | "domain-success" | "machine-boundary"): string {
  return `${domainSlug}:${kind}`;
}

function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function regexPath(path: string): string {
  return `(^|/)${escapeRegExp(path).replace(/\\\//g, "/")}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clean(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized) return normalized;
  let hash = 0;
  for (const ch of value) hash = ((hash << 5) - hash + ch.codePointAt(0)!) | 0;
  return `domain-${Math.abs(hash).toString(36)}`;
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function cloneDesign(design: DomainOrganizationResult): DomainOrganizationResult {
  return JSON.parse(JSON.stringify(design)) as DomainOrganizationResult;
}

function matchesDomain(domain: DomainOrganizationPlan, match: string): boolean {
  return sameName(domain.name, match) || sameName(domain.slug, match);
}

function sameName(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}
