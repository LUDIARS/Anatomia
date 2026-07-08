/**
 * src/web-cache/scene-modules.ts — Build the Scenes web-cache view.
 *
 * A lean, scene-centred hierarchy that shows scene → domain slice → module — no
 * graph. A scene may be a runtime phase, a UI screen, or a workflow/module that
 * spans multiple screens; all of them are rendered as scenes. Every module is
 * pre-decorated with the three facts the panel needs: how many functions it
 * holds, where it accesses (module→module edges), and how many of its functions
 * are in a domain violation.
 *
 * Modules are the SAME structural units the existing Domain View uses
 * (directory-granularity ModuleEvaluation), so cohesion is available and the two
 * views agree. The domain list itself reflects ctx.domains — which already tracks
 * the curated ontology (so taxonomy edits + retune flow through here).
 *
 * SRP: assemble the payload from an analyzed context + module evaluation + scene
 * model. No HTTP, no LLM, no filesystem.
 */

import type { AnchorId } from "../types.js";
import type { AnalysisContext } from "../core.js";
import type { ModuleEvaluation } from "../modules/types.js";
import { buildDomainModules } from "../domains/view-modules.js";
import { computeModuleAccesses } from "./module-access.js";
import type { SceneModel } from "../integral/scene.js";
import type {
  SceneModulesPayload,
  SceneDomainSlice,
  SceneModuleNode,
} from "./types.js";

/**
 * Build the scene/domain/module payload.
 *
 * @param ctx        Analyzed context (domains + graph).
 * @param evaluation Structural module partition (reused from the caller).
 * @param index      anchor → structural module id (from evaluateModulesFromGraph).
 * @param scenes     Scene model (局面); empty model → hasScenes=false.
 */
export async function buildSceneModules(
  ctx: AnalysisContext,
  evaluation: ModuleEvaluation,
  index: Map<AnchorId, string>,
  scenes: SceneModel,
): Promise<SceneModulesPayload> {
  const domains = ctx.domains ?? [];

  // module id → label, and module id → the domains that own ≥1 of its functions.
  const labelById = new Map<string, string>();
  for (const m of evaluation.modules) labelById.set(m.id, m.label);
  const moduleDomains = new Map<string, Set<string>>();
  for (const d of domains) {
    for (const a of d.implementors) {
      const mid = index.get(a);
      if (mid === undefined) continue;
      let set = moduleDomains.get(mid);
      if (!set) moduleDomains.set(mid, (set = new Set()));
      set.add(d.domain);
    }
  }

  // Where each module accesses (module→module edges).
  const accessMap = await computeModuleAccesses(
    ctx.graph,
    (a) => index.get(a),
    {
      labelOf: (m) => labelById.get(m) ?? m,
      domainsOf: (m) => [...(moduleDomains.get(m) ?? [])].sort(),
    },
  );

  // Per-domain module refs (id/label/cohesion/domainAnchors/moduleAnchors).
  const modulesByDomain = buildDomainModules(domains, evaluation);

  const domainSlices: SceneDomainSlice[] = domains
    .filter((d) => d.implementors.length > 0)
    .map((d) => {
      // #violations of this domain that touch each module.
      const violByModule = new Map<string, number>();
      for (const v of d.violations) {
        const touched = new Set<string>();
        for (const a of v.anchors) {
          const mid = index.get(a);
          if (mid !== undefined) touched.add(mid);
        }
        for (const mid of touched) violByModule.set(mid, (violByModule.get(mid) ?? 0) + 1);
      }

      const modules: SceneModuleNode[] = (modulesByDomain[d.domain] ?? []).map((ref) => ({
        moduleId: ref.moduleId,
        label: ref.label,
        functionCount: ref.moduleAnchors,
        domainFunctionCount: ref.domainAnchors,
        cohesion: ref.cohesion,
        violationCount: violByModule.get(ref.moduleId) ?? 0,
        accesses: accessMap.get(ref.moduleId) ?? [],
      }));

      return {
        domain: d.domain,
        conforms: d.conforms,
        violationCount: d.violations.length,
        modules,
      };
    });

  const domainSliceByName = new Map(domainSlices.map((d) => [d.domain, d]));
  const sceneList = scenes.scenes();
  return {
    hasScenes: sceneList.length > 0,
    scenes: sceneList.map((s) => ({
      id: s.id,
      label: s.label,
      domains: s.domains,
      domainSlices: s.domains
        .map((domain) => domainSliceByName.get(domain))
        .filter((domain): domain is SceneDomainSlice => domain !== undefined),
    })),
  };
}
