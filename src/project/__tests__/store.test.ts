import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { resolveHome } from "../store.js";

const originalCwd = process.cwd();
const originalHomeEnv = process.env.ANATOMIA_HOME;

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHomeEnv === undefined) delete process.env.ANATOMIA_HOME;
  else process.env.ANATOMIA_HOME = originalHomeEnv;
});

describe("resolveHome", () => {
  it("prefers explicit home then ANATOMIA_HOME", () => {
    process.env.ANATOMIA_HOME = "/env/home";
    expect(resolveHome("/explicit/home")).toBe("/explicit/home");
    expect(resolveHome()).toBe("/env/home");
  });

  it("uses cwd/.anatomia only when projects.json exists", async () => {
    delete process.env.ANATOMIA_HOME;
    const cwd = await mkdtemp(join(tmpdir(), "anatomia-cwd-home-"));
    try {
      process.chdir(cwd);
      expect(resolveHome()).toBe(join(homedir(), ".anatomia"));

      await mkdir(join(cwd, ".anatomia"), { recursive: true });
      await writeFile(join(cwd, ".anatomia", "projects.json"), '{"projects":[]}\n', "utf8");
      expect(resolveHome()).toBe(join(cwd, ".anatomia"));
    } finally {
      process.chdir(originalCwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
