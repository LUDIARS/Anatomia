/**
 * src/supply/plan/conformance.ts — plan ↔ actually-changed files (design §3.2).
 *
 * The reconciliation the whole plan exists for: after the work is done, did the
 * PR touch the domains it was planned into? A changed file conforms when it is
 * under one of the plan's `plannedPaths` or inside a target domain's declared
 * `membership`. A file outside both is not an error — the plan is a forecast,
 * not a contract — it is the exact spot where the author has to say which
 * domain the file belongs to and add the membership for it.
 *
 * A plan that proposes a NEW domain additionally expects that domain's
 * `.domain.json` in the same diff: Revisor blocks unbound code, so a PR that
 * opens a new surface without declaring it is going to fail later anyway.
 *
 * SRP: comparison logic only. Severity and message shaping belong to the gate
 * (supply/gates/plan_conformance.ts).
 */

import type { Plan, PlanItem } from "./types.js";

/** Result of comparing a diff's changed files against a plan. */
export interface PlanConformance {
  /** True when nothing fell outside the plan and every new domain is declared. */
  pass: boolean;
  /** Repo-relative changed paths that no planned path or membership covers. */
  offPlan: string[];
  /** Names of planned NEW domains whose declaration is absent from the diff. */
  undeclaredNewDomains: string[];
  /** Changed paths the plan accounted for (diagnostics / reporting). */
  onPlan: string[];
}

/** Where a repo's committed domain declarations live, capturing the domain name. */
const DOMAIN_DECLARATION = /^spec\/domains\/([^/]+)\.domain\.json$/;

/** Options for {@link evaluatePlanConformance}. */
export interface PlanConformanceOptions {
  /** Only consider the plan items of this repo (a plan may span several). */
  repo?: string;
}

/** Compare the diff's changed files against the plan. */
export function evaluatePlanConformance(
  plan: Plan,
  changedPaths: string[],
  options: PlanConformanceOptions = {},
): PlanConformance {
  if (!options.repo && plan.repos.length > 1) {
    throw new Error("repo is required when checking a cross-repo plan");
  }
  if (options.repo && !plan.repos.includes(options.repo)) {
    throw new Error(`repo "${options.repo}" is not present in the plan`);
  }
  const items = options.repo ? plan.items.filter((item) => item.repo === options.repo) : plan.items;
  const normalized = [...new Set(changedPaths.map(normalizePath))].sort();

  const onPlan: string[] = [];
  const offPlan: string[] = [];
  for (const path of normalized) {
    if (coveredBy(items, path) || declaresPlannedDomain(items, path)) onPlan.push(path);
    else offPlan.push(path);
  }

  const undeclaredNewDomains = items
    .filter((item) => item.status === "new")
    .filter((item) => !normalized.some((path) => declaredDomain(path) === item.domain))
    .map((item) => item.domain);

  return {
    pass: offPlan.length === 0 && undeclaredNewDomains.length === 0,
    offPlan,
    undeclaredNewDomains: [...new Set(undeclaredNewDomains)].sort(),
    onPlan,
  };
}

/** The domain declared by a canonical `spec/domains/*.domain.json` path. */
function declaredDomain(path: string): string | null {
  return DOMAIN_DECLARATION.exec(path)?.[1] ?? null;
}

/** Domain declarations are on-plan only when they declare one of this repo's items. */
function declaresPlannedDomain(items: PlanItem[], path: string): boolean {
  const domain = declaredDomain(path);
  return domain !== null && items.some((item) => item.domain === domain);
}

/** True when any plan item claims `path`, by planned path or by membership. */
function coveredBy(items: PlanItem[], path: string): boolean {
  return items.some(
    (item) =>
      item.plannedPaths.some((planned) => matchesPlannedPath(planned, path)) ||
      item.ownedPathPatterns.some((pattern) => matchesMembership(pattern, path)),
  );
}

/** Forward slashes, no `./` prefix, no leading `/` — the plan's own path form. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * A planned path may be a file, a directory, or a glob — the decomposition is
 * written by a model in the vocabulary a human would use ("samples/kirie/**").
 * All three are accepted; a directory covers everything under it.
 */
export function matchesPlannedPath(planned: string, path: string): boolean {
  const p = normalizePath(planned).replace(/\/+$/, "");
  if (p === "") return false;
  if (p.includes("*")) return globToRegExp(p).test(path);
  return path === p || path.startsWith(`${p}/`);
}

/** `membership[].pathPattern` is a JS RegExp source; a broken one matches nothing. */
function matchesMembership(pattern: string, path: string): boolean {
  try {
    return new RegExp(pattern).test(path);
  } catch {
    return false;
  }
}

/** `**` spans separators, `*` does not; everything else is literal. */
function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
