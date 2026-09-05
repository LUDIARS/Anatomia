import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { effectiveConfigDirs, effectiveOntologyDir, effectiveSpecDirs } from "../config-paths.js";
import type { Project } from "../types.js";

async function existingDir(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "anatomia-config-paths-"));
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

function project(overrides: Partial<Project> = {}): Project {
  return { id: "pictor", name: "Pictor", rootPath: "/repo", addedAt: "", ...overrides };
}

describe("effectiveOntologyDir", () => {
  it("keeps a dir that exists", async () => {
    const dir = await existingDir("domains");
    expect(effectiveOntologyDir(project({ ontologyDir: dir }))).toBe(dir);
  });

  it("drops a dir the registry still points at after the worktree was deleted", () => {
    // The reported failure: a stale `ontologyDir` made the ontology load throw
    // and the repo report ZERO domains. Dropping it lets the caller fall back
    // to the repo's committed spec/domains.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const gone = join(tmpdir(), "anatomia-does-not-exist", "spec", "domains");
      expect(effectiveOntologyDir(project({ id: "stale-a", ontologyDir: gone }))).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("passes an unset value through untouched", () => {
    expect(effectiveOntologyDir(project())).toBeUndefined();
  });
});

describe("effectiveSpecDirs", () => {
  it("keeps only the dirs that exist, and undefined when none survive", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dir = await existingDir("spec");
      const gone = join(tmpdir(), "anatomia-does-not-exist", "spec");
      expect(effectiveSpecDirs(project({ id: "stale-b", specDirs: [dir, gone] }))).toEqual([dir]);
      expect(effectiveSpecDirs(project({ id: "stale-c", specDirs: [gone] }))).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("effectiveConfigDirs", () => {
  it("feeds the fingerprint only with dirs that can actually be walked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const spec = await existingDir("spec");
      const gone = join(tmpdir(), "anatomia-does-not-exist", "domains");
      const dirs = effectiveConfigDirs(
        project({ id: "stale-d", ontologyDir: gone, specDirs: [spec], knowledgeWriteRoot: "/kw" }),
      );
      expect(dirs).toEqual([spec, "/kw"]);
    } finally {
      warn.mockRestore();
    }
  });
});
