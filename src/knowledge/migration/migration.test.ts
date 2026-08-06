import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import type { Project } from "../../project/types.js";
import { replayKnowledgeLog } from "../log.js";
import { domainEntityId } from "../identity.js";
import type { SceneManifest } from "../scene/types.js";
import { applyLegacyKnowledgeMigration } from "./apply.js";
import { planLegacyKnowledgeMigration } from "./plan.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "anatomia-migration-"));
  roots.push(root);
  const data = join(root, "spec", "data");
  const editable = join(root, ".anatomia", "domains");
  await mkdir(editable, { recursive: true });
  await mkdir(data, { recursive: true });
  const definition = { name: "combat", description: "Combat rules", presetRules: [], templateRules: [] };
  await writeFile(join(editable, "combat.json"), JSON.stringify(definition), "utf8");
  await writeFile(join(data, "Fixture.taxonomy.json"), JSON.stringify({ version: 1, project: "Fixture", iterations: 1,
    domains: [{ name: "combat", description: "Combat rules", modules: [] }] }), "utf8");
  const manualPath = join(data, "Fixture.scenes.json");
  await writeFile(manualPath, JSON.stringify({ version: 1, project: "Fixture",
    scenes: [{ id: "battle", label: "Battle display", domains: ["combat"] }] }), "utf8");
  const project: Project = { id: "fixture", name: "Fixture", rootPath: root, knowledgeWriteRoot: root, addedAt: "2026-08-04T00:00:00Z" };
  const manifest: SceneManifest = {
    schemaVersion: 1, projectionSchema: 1, projectId: "fixture", knowledgeHead: "sha256:head",
    sourceRevision: "sha256:source", definitionFingerprint: "sha256:def", scenes: [{
      id: "scene:fixture/battle", nativeIdentity: "battle", referenceKeys: ["battle"], label: "Battle", kind: "page",
      origin: "route", sourceRevision: "sha256:source", identityBasis: "route-id",
      sourceAnchor: { path: "ui/battle.ts", startLine: 1, endLine: 1, detector: "test", reason: "route" },
      aliases: [], tombstone: false, entryCodeSymbolIds: [], reachedCodeSymbolIds: [], activeDomainIds: [],
      relatedSpecClauseIds: [], containedSceneIds: [], transitionSceneIds: [], elements: [],
    }],
  };
  return { root, project, manifest, manualPath };
}

describe("legacy knowledge migration", () => {
  it("requires reviewed dry-run and retains every legacy source artifact", async () => {
    const { root, project, manifest, manualPath } = await fixture();
    const plan = await planLegacyKnowledgeMigration({ project, state: replayKnowledgeLog(""), sceneManifest: manifest, writeRoot: root });
    expect(plan).toMatchObject({ canApply: true, originalsRetained: true, expectedHead: null });
    expect(plan.inventory.map((item) => item.kind)).toEqual([
      "editable-domain", "domain-def", "taxonomy", "screens", "manual-scenes",
    ]);
    expect(plan.transactionDraft.operations).toHaveLength(1);
    expect(plan.annotationWrites).toHaveLength(1);
    expect(plan.inventory.every((item) => !isAbsolute(item.path))).toBe(true);
    expect(plan.annotationWrites.every((item) => !isAbsolute(item.path))).toBe(true);
    expect(JSON.stringify(plan)).not.toContain(root);
    expect(plan.warnings).toContain("manual scene battle domain override is intentionally not migrated");
    const knowledgeLogPath = join(root, "data", "domain-map", "fixture.knowledge.jsonl");
    const input = { project, knowledgeLogPath, sceneManifest: manifest, writeRoot: root };
    await expect(applyLegacyKnowledgeMigration({ ...input, request: { confirmApply: false,
      expectedSourceFingerprint: plan.sourceFingerprint, expectedHead: plan.expectedHead } })).rejects.toThrow("confirmApply=true");
    const result = await applyLegacyKnowledgeMigration({ ...input, request: { confirmApply: true,
      expectedSourceFingerprint: plan.sourceFingerprint, expectedHead: plan.expectedHead } });
    expect(result.originalsRetained).toBe(true);
    expect(JSON.parse(await readFile(manualPath, "utf8")).scenes).toHaveLength(1);
    expect(replayKnowledgeLog(await readFile(knowledgeLogPath, "utf8")).head).toBe(result.transaction.transactionHash);
    expect(await readFile(join(root, result.annotationPaths[0]!), "utf8")).toContain("kind: scene-annotation");
  });

  it("regenerates the reviewed plan instead of trusting supplied operations or paths", async () => {
    const { root, project, manifest } = await fixture();
    const plan = await planLegacyKnowledgeMigration({ project, state: replayKnowledgeLog(""), sceneManifest: manifest, writeRoot: root });
    const forgedPath = join(root, "forged.md");
    const forgedPlan = {
      ...plan,
      annotationWrites: [{ sceneId: "scene:fixture/battle", path: forgedPath, content: "forged" }],
      transactionDraft: { ...plan.transactionDraft, operations: [{ op: "remove-node" as const, id: "domain:fixture/combat" }] },
    };
    const knowledgeLogPath = join(root, "data", "domain-map", "fixture.knowledge.jsonl");
    const request = { confirmApply: true, expectedSourceFingerprint: plan.sourceFingerprint,
      expectedHead: plan.expectedHead, plan: forgedPlan };
    await applyLegacyKnowledgeMigration({ project, request, knowledgeLogPath, sceneManifest: manifest, writeRoot: root });
    await expect(readFile(forgedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const state = replayKnowledgeLog(await readFile(knowledgeLogPath, "utf8"));
    expect([...state.nodes.keys()]).toEqual([domainEntityId("fixture", "combat")]);
  });

  it("reports malformed JSON artifacts as conflicts instead of trusting their shape", async () => {
    const { root, project, manifest, manualPath } = await fixture();
    await writeFile(manualPath, JSON.stringify({ scenes: [{ id: "battle", domains: "combat" }] }), "utf8");
    const plan = await planLegacyKnowledgeMigration({ project, state: replayKnowledgeLog(""), sceneManifest: manifest, writeRoot: root });
    expect(plan.canApply).toBe(false);
    expect(plan.conflicts).toContainEqual(expect.objectContaining({
      code: "invalid-artifact",
      path: "spec/data/Fixture.scenes.json",
      detail: "invalid manual-scenes shape",
    }));
  });

  it("refuses manual-scene migration from a stale canonical manifest", async () => {
    const { root, project, manifest } = await fixture();
    const plan = await planLegacyKnowledgeMigration({ project, state: replayKnowledgeLog(""), sceneManifest: manifest,
      sceneManifestStaleReasons: ["source-revision-mismatch"], writeRoot: root });
    expect(plan.canApply).toBe(false);
    expect(plan.conflicts).toContainEqual(expect.objectContaining({
      code: "stale-scene-manifest",
      path: "data/generated/anatomia/scene-manifest.json",
    }));
  });

  it("rejects project names that escape the legacy data directory", async () => {
    const { root, project, manifest } = await fixture();
    await expect(planLegacyKnowledgeMigration({ project: { ...project, name: "../Escape" },
      state: replayKnowledgeLog(""), sceneManifest: manifest, writeRoot: root }))
      .rejects.toThrow("project name is not safe");
  });
});
