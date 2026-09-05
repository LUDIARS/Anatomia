import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectCandidates } from "../collect.js";
import { planRepo } from "./helpers.js";

/** A repo whose committed `spec/domains` holds one declaration. */
async function repoWithDeclarations(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "anatomia-plan-collect-"));
  await mkdir(join(root, "spec", "domains"), { recursive: true });
  await writeFile(
    join(root, "spec", "domains", "kirie-transform.domain.json"),
    JSON.stringify({
      name: "kirie-transform",
      description: "写真を多層の切り絵に変換する画像処理。",
      presetRules: [],
      templateRules: [],
      membership: [{ pathPattern: "(^|/)src/kirie/[^/]+$" }],
    }),
    "utf8",
  );
  return root;
}

describe("collectCandidates", () => {
  it("reads the committed declarations, with implementor counts from the analysis", async () => {
    const root = await repoWithDeclarations();
    const repo = { ...planRepo(), repoPath: root };
    const candidates = await collectCandidates(repo);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      repo: "figmentum",
      name: "kirie-transform",
      pathPatterns: ["(^|/)src/kirie/[^/]+$"],
      implementors: 2,
    });
  });

  it("falls back to the detected domains when the repo commits no declarations", async () => {
    // The ontology came from an operator plugin dir: the domains are real, only
    // their declared paths are unavailable.
    const candidates = await collectCandidates(planRepo());
    expect(candidates.map((c) => c.name)).toEqual(["billing", "kirie-transform"]);
    expect(candidates.every((c) => c.pathPatterns.length === 0)).toBe(true);
    expect(candidates[1]!.description).toMatch(/切り絵/);
  });
});
