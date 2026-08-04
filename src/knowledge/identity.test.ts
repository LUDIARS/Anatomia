import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  codeSymbolEntityId,
  domainEntityId,
  entityAlias,
  isProvisionalEntityId,
  provisionalEntityId,
  sceneElementEntityId,
  sceneEntityId,
  specClauseEntityId,
  specDocumentEntityId,
} from "./identity.js";
import { resolveKnowledgeWriteRoot } from "./write-root.js";
import type { Project } from "../project/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("knowledge identity", () => {
  it("provides separate durable codecs for every canonical entity kind", () => {
    const ids = [
      domainEntityId("game", "combat-resolution"),
      specDocumentEntityId("game", "combat-rules"),
      specClauseEntityId("game", "resolve-hit"),
      codeSymbolEntityId("game", "cpp", "combat::resolve(Hit)", "src/combat.cpp"),
      sceneEntityId("game", "engine-guid:abc"),
      sceneElementEntityId("game", "scene:game/battle", "canvas/hp-bar"),
    ];
    expect(new Set(ids).size).toBe(6);
    expect(ids.map((id) => id.split(":")[0])).toEqual([
      "domain", "spec", "spec-clause", "code", "scene", "scene-element",
    ]);
  });

  it("keeps aliases out of the entity id and marks provisional ids", () => {
    const id = provisionalEntityId("spec-clause", "game", "rules/list-item[0]");
    expect(isProvisionalEntityId(id)).toBe(true);
    expect(entityAlias(id, "旧表示名", "git:abc")).toEqual({
      entityId: id,
      alias: "旧表示名",
      revision: "git:abc",
    });
  });
});

describe("knowledge write root", () => {
  it("chooses the conventional repository spec root even with extra read roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-write-root-"));
    roots.push(root);
    await mkdir(join(root, "spec"));
    await mkdir(join(root, "vendor-spec"));
    const project: Project = {
      id: "p", name: "p", rootPath: root, specDirs: [join(root, "spec"), join(root, "vendor-spec")], addedAt: "now",
    };
    expect(resolveKnowledgeWriteRoot(project)).toBe(join(root, "spec"));
  });

  it("rejects an explicit write root outside the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-write-root-"));
    const outside = await mkdtemp(join(tmpdir(), "anatomia-write-outside-"));
    roots.push(root, outside);
    const project: Project = {
      id: "p", name: "p", rootPath: root, knowledgeWriteRoot: outside, addedAt: "now",
    };
    expect(() => resolveKnowledgeWriteRoot(project)).toThrow(/inside project root/);
  });
});
