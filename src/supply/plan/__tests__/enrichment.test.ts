import { describe, expect, it } from "vitest";
import { collectDataDefs, domainFiles } from "../data-defs.js";
import { findDuplicates } from "../duplicates.js";
import { findExemplar } from "../exemplar.js";
import { planCandidates, planRepo } from "./helpers.js";

const candidate = (name: string) => planCandidates().find((c) => c.name === name);

describe("domainFiles", () => {
  it("unions the implementors' files with the declared membership paths", () => {
    const files = domainFiles(planRepo(), "kirie-transform", candidate("kirie-transform"));
    expect([...files].sort()).toEqual(["src/kirie/transform.cpp", "third_party/stb_image.h"]);
  });
});

describe("collectDataDefs", () => {
  it("lists the domain's own types and public functions", async () => {
    const defs = await collectDataDefs(planRepo(), "kirie-transform", candidate("kirie-transform"));
    expect(defs.filter((d) => d.kind === "type").map((d) => d.name)).toEqual([
      "KirieLayer",
      "PaperPalette",
    ]);
    expect(defs.filter((d) => d.kind === "function").map((d) => d.name)).toContain(
      "TransformImage",
    );
    // Another domain's type is not this domain's vocabulary.
    expect(defs.map((d) => d.name)).not.toContain("Invoice");
  });
});

describe("findDuplicates", () => {
  it("reports an existing symbol with the same vocabulary, outside the domain", () => {
    const own = domainFiles(planRepo(), "billing", candidate("billing"));
    const hits = findDuplicates(
      planRepo(),
      { responsibility: "transform the image", neededTypes: ["TransformImage"] },
      own,
    );
    expect(hits.map((h) => h.name)).toContain("TransformImage");
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it("never reports the target domain's own members", () => {
    const own = domainFiles(planRepo(), "kirie-transform", candidate("kirie-transform"));
    const hits = findDuplicates(
      planRepo(),
      { responsibility: "transform image", neededTypes: ["KirieLayer"] },
      own,
    );
    expect(hits.map((h) => h.path)).not.toContain("src/kirie/transform.cpp");
  });
});

describe("findExemplar", () => {
  it("prefers the repo's own layer over the far more referenced vendored file", async () => {
    const exemplar = await findExemplar(planRepo(), "kirie-transform");
    expect(exemplar).toMatchObject({
      name: "TransformImage",
      path: "src/kirie/transform.cpp",
      layer: "src",
      references: 5,
    });
  });

  it("returns null for a domain with no implementor", async () => {
    const repo = planRepo();
    repo.ctx.domains!.push({
      domain: "empty",
      implementors: [],
      violations: [],
      conforms: true,
    });
    expect(await findExemplar(repo, "empty")).toBeNull();
  });
});
