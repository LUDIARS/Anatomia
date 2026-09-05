import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProgramDomainConfig } from "./config.js";
import { buildLayerPolicy, validateLayerDeclaration } from "./layer-policy.js";
import { layerOfPath } from "./layer-paths.js";

async function repoWithLayers(content: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "anatomia-layers-"));
  await mkdir(join(root, ".anatomia"), { recursive: true });
  await writeFile(join(root, ".anatomia", "layers.json"), JSON.stringify(content), "utf8");
  return root;
}

describe("buildLayerPolicy", () => {
  it("keeps the builtin ranking when the repository declares nothing", () => {
    const policy = buildLayerPolicy({ layers: [], mergeCouplingThreshold: 1 });
    expect(policy.source).toBe("builtin");
    expect(policy.allows("presentation", "domain")).toBe(true);
    expect(policy.allows("domain", "presentation")).toBe(false);
    // Never null: an undeclared repo must keep exactly the verdicts it had.
    expect(policy.allows("unknown", "presentation")).toBe(false);
  });

  it("follows a declared order instead of the builtin ranking", () => {
    const policy = buildLayerPolicy({
      layers: [],
      mergeCouplingThreshold: 1,
      // Deliberately the reverse of the builtin ranking.
      order: ["presentation", "application", "domain"],
    });
    expect(policy.source).toBe("declared-order");
    expect(policy.allows("domain", "presentation")).toBe(true);
    expect(policy.allows("presentation", "domain")).toBe(false);
    expect(policy.allows("domain", "unlisted")).toBeNull();
  });

  it("expresses an onion with allow, and allow wins over order", () => {
    const policy = buildLayerPolicy({
      layers: [],
      mergeCouplingThreshold: 1,
      order: ["domain", "application", "presentation"],
      allow: { domain: [], application: ["domain"], presentation: ["application"] },
    });
    expect(policy.source).toBe("declared-allow");
    expect(policy.allows("presentation", "application")).toBe(true);
    // The order would allow presentation -> domain; the explicit allow does not.
    expect(policy.allows("presentation", "domain")).toBe(false);
    expect(policy.allows("domain", "domain")).toBe(true);
    expect(policy.allows("infrastructure", "domain")).toBeNull();
    // `allow` decides verdicts; the declared `order` still drives display order.
    expect(policy.layers).toEqual(["domain", "application", "presentation"]);
  });
});

describe("validateLayerDeclaration", () => {
  it("rejects an undeclared layer name, a repeated order and a cycle", () => {
    expect(() => validateLayerDeclaration({ order: ["ui"] }, [])).toThrow(/undeclared layer "ui"/);
    expect(() => validateLayerDeclaration({ order: ["domain", "domain"] }, []))
      .toThrow(/repeats layer "domain"/);
    expect(() => validateLayerDeclaration(
      { allow: { domain: ["application"], application: ["domain"] } },
      [],
    )).toThrow(/dependency cycle/);
  });

  it("requires every declared layer to appear as an allow key", () => {
    expect(() => validateLayerDeclaration(
      { allow: { domain: [] } },
      [{ layer: "domain" }, { layer: "ui" }],
    )).toThrow(/missing declared layer "ui"/);
  });

  it("accepts a custom layer declared in both layers and the policy", () => {
    expect(() => validateLayerDeclaration(
      { order: ["ui"], allow: { ui: [] } },
      [{ layer: "ui" }],
    )).not.toThrow();
  });
});

describe("loadProgramDomainConfig", () => {
  it("loads a declared order and allow", async () => {
    const root = await repoWithLayers({
      layers: [{ glob: "src/ui/**", layer: "presentation" }],
      mergeCouplingThreshold: 1,
      order: ["domain", "presentation"],
      allow: { presentation: ["domain"], domain: [] },
    });
    const config = await loadProgramDomainConfig(root);
    expect(config.order).toEqual(["domain", "presentation"]);
    expect(config.allow).toEqual({ domain: [], presentation: ["domain"] });
  });

  it("fails fast on a broken declaration instead of falling back to the default order", async () => {
    const root = await repoWithLayers({
      layers: [],
      mergeCouplingThreshold: 1,
      order: ["domain", "nowhere"],
    });
    await expect(loadProgramDomainConfig(root)).rejects.toThrow(/undeclared layer "nowhere"/);
  });

  it("keeps the previous shape when the file declares no policy", async () => {
    const root = await repoWithLayers({
      layers: [{ glob: "src/**", layer: "domain" }],
      mergeCouplingThreshold: 2,
    });
    const config = await loadProgramDomainConfig(root);
    expect(config.order).toBeUndefined();
    expect(config.allow).toBeUndefined();
    expect(buildLayerPolicy(config).source).toBe("builtin");
  });
});

describe("layerOfPath", () => {
  it("uses the repository globs first and the dependency rule second", () => {
    const config = { layers: [{ glob: "src/ui/**", layer: "presentation" }], mergeCouplingThreshold: 1 };
    expect(layerOfPath(config, "src/ui/panel.ts")).toBe("presentation");
    expect(layerOfPath(config, "package.json")).toBe("infrastructure");
    expect(layerOfPath(config, "src/core/graph.ts")).toBeNull();
  });
});
