import { detectScreens } from "../../screens/index.js";
import type { KnowledgeProjectPort } from "./port.js";
import { deriveCanonicalSceneGraph } from "../scene/derive.js";
import { inventoryFromManifest, inventoryScreenScenes, reconcileSceneInventory } from "../scene/inventory.js";
import { computeSceneSourceRevision, readProjectSceneInspection, sceneKnowledgePaths } from "../scene/project-reader.js";
import { readSceneManifest } from "../scene/reader.js";
import { syncCanonicalScenes } from "../scene/sync.js";
import type { DomainKnowledgeApplication } from "./domain-application.js";

// @implements SPEC-knowledge-adapter-migration

export class SceneKnowledgeApplication {
  constructor(private readonly port: KnowledgeProjectPort, private readonly domains: DomainKnowledgeApplication) {}

  query() { return readProjectSceneInspection(this.port.project); }

  async sync(request: { confirmSync: boolean; expectedHead: string | null }) {
    if (request.confirmSync !== true) throw new Error("scene sync requires confirmSync=true");
    const paths = sceneKnowledgePaths(this.port.project);
    const state = await this.domains.state();
    if (request.expectedHead !== state.head) throw new Error(`scene sync head conflict: expected ${request.expectedHead}, got ${state.head}`);
    const context = await this.port.context();
    const sourceRevision = await computeSceneSourceRevision(this.port.project);
    const current = await inventoryScreenScenes(this.port.project.id, context, await detectScreens(context), sourceRevision);
    let definitions = current;
    try {
      const previous = await readSceneManifest(paths.manifestPath);
      definitions = reconcileSceneInventory(inventoryFromManifest(previous.manifest), current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const graph = await deriveCanonicalSceneGraph({ projectId: this.port.project.id, sourceRevision, context,
      definitions, knowledgeState: state });
    return syncCanonicalScenes({ graph, knowledgeLogPath: paths.knowledgeLogPath, generatedRoot: paths.generatedRoot,
      expectedHead: state.head, readCurrentSourceRevision: () => computeSceneSourceRevision(this.port.project) });
  }
}
