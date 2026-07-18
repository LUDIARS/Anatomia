import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../../../core.js";
import { buildVisData } from "../vis-data.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("buildVisData graph views", () => {
  it("returns the intact function graph plus an aggregated class projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-vis-class-"));
    roots.push(root);
    await mkdir(join(root, "Assets"), { recursive: true });
    await mkdir(join(root, "ProjectSettings"), { recursive: true });
    await writeFile(join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 2021.3.0f1\n");
    await writeFile(
      join(root, "Assets", "Classes.cs"),
      [
        "class A : MonoBehaviour {",
        "  void Update() { B target; target.Tick(); }",
        "}",
        "class B { void Tick() {} }",
      ].join("\n"),
    );

    const ctx = await analyze(root, { quiet: true });
    const data = await buildVisData(ctx);

    expect(data.defaultView).toBe("class");
    expect(data.nodes.map((node) => node.label).sort()).toEqual(["Tick", "Update"]);
    expect(data.views.function.edges.some((edge) => edge.label === "calls")).toBe(true);
    expect(data.views.class.nodes.map((node) => node.label).sort()).toEqual(["A", "B"]);
    expect(data.views.class.edges.some((edge) => edge.label === "calls")).toBe(true);
    expect(data.views.function.nodes.find((node) => node.label === "Update")?._meta.lifecycle)
      .toBe("Update");
  });
});
