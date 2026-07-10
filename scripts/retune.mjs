/**
 * scripts/retune.mjs — Domain-view self-adjustment runner.
 *
 * Runs the 7-step re-tune pipeline (spec/feature/domain-retune.md) against a
 * repo and registers the resulting taxonomy. Defaults to Anatomia itself.
 *
 * Usage:  npm run build && npm run retune
 *   RETUNE_REPO      repo root to re-tune        (default: cwd)
 *   RETUNE_PROJECT   project id for artifacts     (default: anatomia)
 *   plus the provider env (ANTHROPIC_API_KEY / ANATOMIA_LLM_BACKEND / …) and the
 *   thresholds RETUNE_MAX_MODULES_PER_DOMAIN / RETUNE_MIN_NODES_PER_MODULE /
 *   RETUNE_HALT_AFTER / RETUNE_LARGE_PERCENTILE.
 *
 * Imports from dist/ — run `npm run build` first.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveProviders } from "../dist/providers/index.js";
import { analyze } from "../dist/core.js";
import { buildDomainReview } from "../dist/review/index.js";
import { runRetuneOnContext } from "../dist/domains/retune/index.js";

const repoPath = process.env.RETUNE_REPO || process.cwd();
const project = process.env.RETUNE_PROJECT || "anatomia";
const largePercentile = process.env.RETUNE_LARGE_PERCENTILE
  ? Number(process.env.RETUNE_LARGE_PERCENTILE)
  : undefined;

async function main() {
  const providers = resolveProviders();
  console.error(`[retune] providers: ${providers.describe()}`);
  console.error(`[retune] repo=${repoPath} project=${project}`);

  // review → retune 還流: analyze once, run the deterministic domain review on
  // that context, and hand the findings to the pipeline as split/merge evidence.
  const ctx = await analyze(repoPath, { quiet: true });
  const reviewFindings = await buildDomainReview(ctx);
  console.error(
    `[retune] domain review: ${reviewFindings.summary.domains} domains, ` +
      `coverage ${(reviewFindings.summary.coverage * 100).toFixed(1)}%, ` +
      `boundaryDrift ${reviewFindings.summary.boundaryDrift}, overlap ${reviewFindings.summary.overlap}`,
  );

  const report = await runRetuneOnContext(ctx, {
    project,
    llm: providers.llm,
    reviewFindings,
    options: { now: new Date().toISOString(), largePercentile },
  });

  // Persist ontologyDir on the project record so the live panel loads the
  // generated DomainDefs (projects.json is local / gitignored).
  try {
    const regPath = join(repoPath, ".anatomia", "projects.json");
    const snap = JSON.parse(await readFile(regPath, "utf8"));
    const sel = snap.projects?.find((p) => p.id === snap.selected) ?? snap.projects?.[0];
    if (sel) {
      sel.ontologyDir = report.ontologyDir;
      await writeFile(regPath, JSON.stringify(snap, null, 2) + "\n", "utf8");
      console.error(`[retune] set ontologyDir on project "${sel.id}" → ${report.ontologyDir}`);
    }
  } catch (err) {
    console.error("[retune] projects.json ontologyDir update skipped:", String(err));
  }

  // Human-readable summary to stderr; machine summary (JSON) to stdout.
  for (const s of report.steps) {
    console.error(`  step ${s.step} [${s.llm ? "LLM " : "mech"}] ${s.title} — ${s.summary}`);
    for (const n of s.notes ?? []) console.error(`      · ${n}`);
  }
  console.error(
    `[retune] iteration ${report.iteration} — ${report.taxonomy.domains.length} domains, ` +
      `${report.taxonomy.domains.reduce((a, d) => a + d.modules.length, 0)} modules, ` +
      `${report.taxonomy.unassigned?.count ?? 0} unassigned`,
  );
  if (report.humanReviewNotes.length) {
    console.error("\n=== 人間判断 (step 7) ===");
    for (const n of report.humanReviewNotes) console.error(n);
  }

  console.log(
    JSON.stringify(
      {
        project: report.project,
        iteration: report.iteration,
        haltForHuman: report.haltForHuman,
        written: report.written,
        domains: report.taxonomy.domains.map((d) => ({
          name: d.name,
          description: d.description,
          modules: d.modules.map((m) => ({ name: m.name, paths: m.paths })),
        })),
        unassigned: report.taxonomy.unassigned,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
