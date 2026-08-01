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
    expect(data.edges.some((edge) => edge.label === "calls")).toBe(true);
    expect(data.views.class.nodes.map((node) => node.label).sort()).toEqual(["A", "B"]);
    expect(data.views.class.edges.some((edge) => edge.label === "calls")).toBe(true);
    expect(data.nodes.find((node) => node.label === "Update")?._meta.lifecycle)
      .toBe("Update");
    expect(data.nodes.every((node) => node._meta.domain === "unassigned")).toBe(true);
    expect(data.views.class.nodes.every((node) => node._meta.domain === "unassigned")).toBe(true);
    expect(data.views.class.nodes.every((node) => node.title.includes("domain: unassigned")))
      .toBe(true);
    expect(data.views.function).toBeUndefined();
    expect(JSON.parse(JSON.stringify(data)).views.function).toBeUndefined();
  });

  it("keeps a singular primary class domain while listing every domain in the tooltip", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-vis-class-domain-"));
    roots.push(root);
    await mkdir(join(root, "Assets"), { recursive: true });
    await mkdir(join(root, "ProjectSettings"), { recursive: true });
    await writeFile(
      join(root, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 2021.3.0f1\n",
    );
    await writeFile(
      join(root, "Assets", "Mixed.cs"),
      "class Mixed { void Attack() {} void Draw() {} }\n",
    );

    const ctx = await analyze(root, { quiet: true });
    const attack = ctx.functions.find((fn) => fn.name === "Attack")?.id;
    const draw = ctx.functions.find((fn) => fn.name === "Draw")?.id;
    if (!attack || !draw) throw new Error("missing mixed-class anchors");
    const [primaryAnchor, secondaryAnchor] = [attack, draw].sort();
    ctx.domains = [
      { domain: "combat", implementors: [primaryAnchor!], violations: [], conforms: true },
      { domain: "ui", implementors: [secondaryAnchor!], violations: [], conforms: true },
    ];

    const data = await buildVisData(ctx);
    const mixed = data.views.class.nodes.find((node) => node.label === "Mixed");
    expect(mixed?._meta.domain).toBe("combat");
    expect(mixed?._meta.domainOverlap).toBe(1);
    expect(mixed?.title).toContain("domain: combat, ui");
  });
});
