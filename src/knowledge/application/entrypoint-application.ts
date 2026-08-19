/**
 * src/knowledge/application/entrypoint-application.ts — Entry-point use cases.
 *
 * `query()` reads the prepared artifact and never analyses — the panel and the
 * CLI must be able to ask "where does this product start" without paying for a
 * re-analysis. `sync()` is the write path: detect → derive → commit → project,
 * guarded by the same head check the scene sync uses so two concurrent syncs
 * cannot interleave transactions.
 *
 * SRP: use-case orchestration. Detection/derivation live in src/entrypoints/.
 */

import { detectEntryPoints } from "../../entrypoints/detect.js";
import { deriveEntryPointGraph } from "../../entrypoints/derive.js";
import { buildColoring } from "../../entrypoints/coloring.js";
import { materializeEntryPointGraph } from "../entrypoint/derive.js";
import {
  computeEntryPointSourceRevision,
  entryPointKnowledgePaths,
  readProjectEntryPointInspection,
} from "../entrypoint/project-reader.js";
import { syncCanonicalEntryPoints } from "../entrypoint/sync.js";
import type { DomainKnowledgeApplication } from "./domain-application.js";
import type { KnowledgeProjectPort } from "./port.js";

export class EntryPointKnowledgeApplication {
  constructor(
    private readonly port: KnowledgeProjectPort,
    private readonly domains: DomainKnowledgeApplication,
  ) {}

  /** Read the prepared entry graph. No analysis, no writes. */
  query() {
    return readProjectEntryPointInspection(this.port.project);
  }

  /** Derive and commit the entry graph for the project's current sources. */
  async sync() {
    const paths = entryPointKnowledgePaths(this.port.project);
    const state = await this.domains.state();
    const context = await this.port.context();
    const sourceRevision = await computeEntryPointSourceRevision(this.port.project);
    const graph = await deriveEntryPointGraph({
      projectId: this.port.project.id,
      sourceRevision,
      context,
      manifest: await detectEntryPoints(context),
      coloring: buildColoring(context, state),
    });
    const canonical = materializeEntryPointGraph({
      graph,
      projectRoot: this.port.project.rootPath,
      functions: context.functions,
      // Read-only: an activates-domain edge may only point at a domain the log
      // already holds, so the entry layer never creates one.
      knownDomainIds: new Set([...state.nodes.values()]
        .filter((node) => node.kind === "domain")
        .map((node) => node.id)),
    });
    return syncCanonicalEntryPoints({
      canonical,
      knowledgeLogPath: paths.knowledgeLogPath,
      generatedRoot: paths.generatedRoot,
      expectedHead: state.head,
      readCurrentSourceRevision: () => computeEntryPointSourceRevision(this.port.project),
    });
  }
}
