/**
 * The registry the bundle walks is shared and nothing prunes it, so the index
 * used to carry the wreckage: deleted worktrees whose directory survives holding
 * only `.anatomia`, and one repository registered twice under two ids — which
 * put 「影絵デモ — 切り絵バックドロップ」 in the results twice at the same score.
 *
 * Pinned here: what counts as dead, what counts as the same repository, and
 * which of two registrations of one repo represents it.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { clearDomainMapMemo, loadDomainMapBundle } from "../bundle.js";
import { searchDomainMap } from "../search.js";
import {
  isGeneratedProjectId,
  normalizeMapSources,
  type ProjectRootProbe,
} from "../project-roots.js";

const execFileAsync = promisify(execFile);
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** A probe that answers from a table instead of the filesystem. */
function fakeProbe(table: Record<string, Partial<ProjectRootProbe>>) {
  return async (rootPath: string): Promise<ProjectRootProbe> => ({
    dead: null,
    key: rootPath.toLowerCase(),
    isMainCheckout: true,
    ...table[rootPath],
  });
}

afterEach(() => {
  clearDomainMapMemo();
});

describe("normalizeMapSources", () => {
  it("drops a root that is gone and one that holds only the analysis cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-map-roots-"));
    try {
      const emptied = join(root, "wt-thaleia-review");
      const alive = join(root, "thaleia");
      await mkdir(join(emptied, ".anatomia"), { recursive: true });
      await mkdir(alive, { recursive: true });
      await writeFile(join(alive, "README.md"), "# thaleia\n", "utf8");

      const result = await normalizeMapSources(
        [
          { id: "thaleia", rootPath: alive },
          { id: "wt-thaleia-review", rootPath: emptied },
          { id: "gone", rootPath: join(root, "never-existed") },
        ],
        { probeCacheMs: 0 },
      );

      expect(result.sources.map((source) => source.id)).toEqual(["thaleia"]);
      expect(result.notes.join(" ")).toContain("gone");
      expect(result.notes.join(" ")).toContain("wt-thaleia-review");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("folds a linked worktree into the main checkout when both are registered", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-map-worktree-"));
    try {
      const main = join(root, "pictor");
      const linked = join(root, "pictor-feat-kirie");
      await mkdir(join(main, "src"), { recursive: true });
      await writeFile(join(main, "README.md"), "# pictor\n", "utf8");
      await writeFile(join(main, "src", "index.ts"), "export {};\n", "utf8");
      await git(main, ["init", "-q", "-b", "main"]);
      await git(main, ["add", "-A"]);
      await git(main, [
        "-c", "user.email=test@example.com", "-c", "user.name=test",
        "commit", "-q", "-m", "init",
      ]);
      await git(main, ["worktree", "add", "-q", "-b", "feat/kirie", linked]);

      const result = await normalizeMapSources(
        [
          { id: "pictor-5bfd9645e639", rootPath: linked },
          { id: "pictor", rootPath: main },
        ],
        { probeCacheMs: 0 },
      );

      expect(result.sources.map((source) => source.id)).toEqual(["pictor"]);
      expect(result.notes.join(" ")).toContain("pictor-5bfd9645e639 → pictor");

      const scoped = await normalizeMapSources(
        [
          { id: "pictor-src-5bfd9645e639", rootPath: join(linked, "src") },
          { id: "pictor-src", rootPath: join(main, "src") },
        ],
        { probeCacheMs: 0 },
      );
      expect(scoped.sources.map((source) => source.id)).toEqual(["pictor-src"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a worktree when the repository it came from is not registered", async () => {
    const result = await normalizeMapSources(
      [{ id: "satelles-fix-sandbox", rootPath: "/repos/satelles-fix-sandbox" }],
      {
        probe: fakeProbe({
          "/repos/satelles-fix-sandbox": { key: "/repos/satelles", isMainCheckout: false },
        }),
      },
    );
    expect(result.sources.map((source) => source.id)).toEqual(["satelles-fix-sandbox"]);
    expect(result.notes).toEqual([]);
  });

  it("prefers the human-readable id over the generated <name>-<hash> one", async () => {
    const sources = [
      { id: "pictor-5bfd9645e639", rootPath: "/repos/Pictor" },
      { id: "pictor", rootPath: "/repos/pictor" },
    ];
    const probe = fakeProbe({
      "/repos/Pictor": { key: "/repos/pictor" },
      "/repos/pictor": { key: "/repos/pictor" },
    });
    expect((await normalizeMapSources(sources, { probe })).sources.map((s) => s.id))
      .toEqual(["pictor"]);
    // Registration order must not decide it.
    expect((await normalizeMapSources([...sources].reverse(), { probe })).sources.map((s) => s.id))
      .toEqual(["pictor"]);
  });

  it("prefers a registered main checkout over a worktree with a plainer id", async () => {
    const result = await normalizeMapSources(
      [
        { id: "wt-augur-design", rootPath: "/repos/wt-augur-design" },
        { id: "augur-04fa2c92152f", rootPath: "/repos/Augur" },
      ],
      {
        probe: fakeProbe({
          "/repos/wt-augur-design": { key: "/repos/augur", isMainCheckout: false },
          "/repos/Augur": { key: "/repos/augur", isMainCheckout: true },
        }),
      },
    );
    expect(result.sources.map((source) => source.id)).toEqual(["augur-04fa2c92152f"]);
  });

  it("keeps a subdirectory registration distinct from its repository root", async () => {
    const result = await normalizeMapSources(
      [
        { id: "ars", rootPath: "/repos/Ars" },
        { id: "ars-console", rootPath: "/repos/Ars/ars-console" },
      ],
      {
        probe: fakeProbe({
          "/repos/Ars": { key: "repo-root" },
          "/repos/Ars/ars-console": { key: "repo-subdirectory" },
        }),
      },
    );
    expect(result.sources.map((source) => source.id)).toEqual(["ars", "ars-console"]);
  });
});

describe("isGeneratedProjectId", () => {
  it("recognises the registry's collision suffix and nothing else", () => {
    expect(isGeneratedProjectId("pictor-5bfd9645e639")).toBe(true);
    expect(isGeneratedProjectId("concordia-3ffbb1f667cd")).toBe(true);
    expect(isGeneratedProjectId("pictor-5bfd9645")).toBe(false);
    expect(isGeneratedProjectId("pictor-5bfd9645e639aa")).toBe(false);
    expect(isGeneratedProjectId("pictor")).toBe(false);
    expect(isGeneratedProjectId("vtn-connect")).toBe(false);
    expect(isGeneratedProjectId("all-in-onetest")).toBe(false);
    expect(isGeneratedProjectId("ars-feat-domain-review-skills")).toBe(false);
  });
});

describe("loadDomainMapBundle", () => {
  it("answers once for a repository that is registered twice", async () => {
    const root = join(FIXTURES, "pictor");
    const bundle = await loadDomainMapBundle(
      [
        { id: "pictor", rootPath: root },
        { id: "pictor-5bfd9645e639", rootPath: root },
      ],
      { roster: { codes: [], error: null }, refresh: true },
    );

    expect(bundle.index.projects).toEqual(["pictor"]);
    const hits = searchDomainMap(bundle.index, "切り絵のデモを実装する", { limit: 10 });
    const backdrop = hits.filter((hit) => hit.name === "影絵デモ — 切り絵バックドロップ");
    expect(backdrop).toHaveLength(1);
    expect(bundle.notes.join(" ")).toContain("pictor-5bfd9645e639 → pictor");
  });
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}
