import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeGeneratedArtifacts } from "./artifact-writer.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function request(root: string, artifacts: Array<{ path: string; content: string; entityId: string }>) {
  return {
    generatedRoot: root,
    artifacts,
    knowledgeHead: "sha256:head",
    sourceRevision: "git:a",
    sourceFingerprint: "sha256:source",
    generatorSchema: 1,
    projectionSchema: 1,
  };
}

describe("generated artifact ownership writer", () => {
  it("is idempotent and removes only stale manifest-owned files", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-generated-"));
    roots.push(root);
    await writeFile(join(root, "human.md"), "human\n", "utf8");
    await writeGeneratedArtifacts(request(root, [{ path: "scenes/a.md", content: "a\r\n", entityId: "scene:p/a" }]));
    const second = await writeGeneratedArtifacts(request(root, [{ path: "scenes/a.md", content: "a\n", entityId: "scene:p/a" }]));
    expect(second.written).toEqual([]);
    expect(second.unchanged).toEqual(["scenes/a.md"]);

    const third = await writeGeneratedArtifacts(request(root, [{ path: "scenes/b.md", content: "b\n", entityId: "scene:p/b" }]));
    expect(third.removed).toEqual(["scenes/a.md"]);
    expect(await readFile(join(root, "human.md"), "utf8")).toBe("human\n");
    await expect(readFile(join(root, "scenes/a.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects traversal before replacing the owned set", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-generated-"));
    roots.push(root);
    await expect(writeGeneratedArtifacts(request(root, [
      { path: "../outside", content: "bad", entityId: "scene:p/bad" },
    ]))).rejects.toThrow(/unsafe/);
  });
});
