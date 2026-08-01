import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnalysisCache,
  ARTIFACT_CACHE_SCHEMA_VERSION,
  SNAPSHOT_CACHE_SCHEMA_VERSION,
} from "../cache.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("snapshot cache analyzer schema", () => {
  it("rejects a legacy domain summary even when the project fingerprint still matches", async () => {
    const home = await mkdtemp(join(tmpdir(), "anatomia-snapshot-version-"));
    homes.push(home);
    const cache = new AnalysisCache(home);
    const projectDir = cache.dirFor("project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "snapshot.json"),
      JSON.stringify({
        version: 2,
        projectId: "project",
        fingerprint: "same-source",
        merkleHash: "same-source-merkle",
        fileCount: 1,
        functionCount: 1,
        summary: {
          files: 1,
          functions: 1,
          nodes: 1,
          edges: 0,
          domains: 3,
          links: 0,
          domainHealth: {
            detectedDomains: 3,
            detectedCuratedDomains: 1,
            activeDomains: 3,
            builtinDomains: 2,
            expectedCuratedDomains: null,
            functionCount: 1,
            warnings: [],
          },
        },
        analyzedAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );

    await expect(cache.readSnapshot("project")).resolves.toBeNull();
  });

  it("accepts the current snapshot analyzer schema", async () => {
    const home = await mkdtemp(join(tmpdir(), "anatomia-snapshot-version-"));
    homes.push(home);
    const cache = new AnalysisCache(home);
    const projectDir = cache.dirFor("project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "snapshot.json"),
      JSON.stringify({
        version: SNAPSHOT_CACHE_SCHEMA_VERSION,
        projectId: "project",
        fingerprint: "same-source",
        merkleHash: "same-source-merkle",
        fileCount: 1,
        functionCount: 1,
        analyzedAt: "2026-07-31T00:00:00.000Z",
      }),
      "utf8",
    );

    await expect(cache.readSnapshot("project")).resolves.toMatchObject({
      version: SNAPSHOT_CACHE_SCHEMA_VERSION,
      fingerprint: "same-source",
    });
  });
});

describe("artifact cache analyzer schema", () => {
  it("rejects legacy payloads even when the project fingerprint still matches", async () => {
    const home = await mkdtemp(join(tmpdir(), "anatomia-artifact-version-"));
    homes.push(home);
    const cache = new AnalysisCache(home);
    const projectDir = cache.dirFor("project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "artifact-domains.json"),
      JSON.stringify({
        version: 2,
        fingerprint: "same-source",
        builtAt: "2026-01-01T00:00:00.000Z",
        data: [{ domain: "state-machine" }],
      }),
      "utf8",
    );

    await expect(cache.readArtifact("project", "domains", "same-source"))
      .resolves.toBeNull();
  });

  it("writes and accepts only the current analyzer artifact schema", async () => {
    const home = await mkdtemp(join(tmpdir(), "anatomia-artifact-version-"));
    homes.push(home);
    const cache = new AnalysisCache(home);
    await cache.writeArtifact("project", "domains", "same-source", [
      { domain: "transition-guard-example" },
    ]);

    const raw = JSON.parse(
      await readFile(join(cache.dirFor("project"), "artifact-domains.json"), "utf8"),
    ) as { version: number };
    expect(raw.version).toBe(ARTIFACT_CACHE_SCHEMA_VERSION);
    await expect(cache.readArtifact("project", "domains", "same-source"))
      .resolves.toEqual([{ domain: "transition-guard-example" }]);
  });
});
