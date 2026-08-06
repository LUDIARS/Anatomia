import type { LegacyMigrationApplyRequest } from "../migration/types.js";
import { applyLegacyKnowledgeMigration } from "../migration/apply.js";
import { planLegacyKnowledgeMigration } from "../migration/plan.js";
import { sceneKnowledgePaths } from "../scene/project-reader.js";
import { DomainKnowledgeApplication } from "./domain-application.js";
import type { KnowledgeProjectPort } from "./port.js";
import { SceneKnowledgeApplication } from "./scene-application.js";

// @implements SPEC-knowledge-adapter-migration

export class KnowledgeApplicationService {
  readonly domains: DomainKnowledgeApplication;
  readonly scenes: SceneKnowledgeApplication;

  constructor(private readonly port: KnowledgeProjectPort) {
    this.domains = new DomainKnowledgeApplication(port);
    this.scenes = new SceneKnowledgeApplication(port, this.domains);
  }

  async status() {
    const state = await this.domains.state();
    try {
      const inspection = await this.scenes.query();
      return { projectId: this.port.project.id, knowledgeHead: state.head, sourceRevision: inspection.manifest.sourceRevision,
        rebuildRequired: inspection.stale, sceneProjection: inspection.stale ? "stale" as const : "current" as const,
        staleReasons: inspection.staleReasons };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { projectId: this.port.project.id, knowledgeHead: state.head, sourceRevision: null,
        rebuildRequired: true, sceneProjection: "missing" as const, staleReasons: ["manifest-missing"] };
    }
  }

  private async migrationSceneInput() {
    try {
      const inspection = await this.scenes.query();
      return { sceneManifest: inspection.manifest, sceneManifestStaleReasons: inspection.staleReasons };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { sceneManifest: null, sceneManifestStaleReasons: ["manifest-missing"] };
    }
  }

  async planLegacyMigration() {
    const paths = sceneKnowledgePaths(this.port.project);
    const sceneInput = await this.migrationSceneInput();
    return planLegacyKnowledgeMigration({ project: this.port.project, state: await this.domains.state(), ...sceneInput,
      writeRoot: paths.writeRoot });
  }

  async applyLegacyMigration(request: LegacyMigrationApplyRequest) {
    const paths = sceneKnowledgePaths(this.port.project);
    const sceneInput = await this.migrationSceneInput();
    return applyLegacyKnowledgeMigration({
      project: this.port.project,
      request,
      knowledgeLogPath: this.domains.knowledgeLogPath,
      ...sceneInput,
      writeRoot: paths.writeRoot,
    });
  }
}
