import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGraphViewForPaths, detectProjectKind } from "../profile.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project profile", () => {
  it("uses class view for C++/C#/Java and function view for TypeScript/Go", () => {
    expect(defaultGraphViewForPaths(["a.cpp", "b.cs", "C.java"])).toBe("class");
    expect(defaultGraphViewForPaths(["a.ts", "b.tsx", "main.go"])).toBe("function");
    expect(defaultGraphViewForPaths(["a.cs", "b.ts"])).toBe("class");
  });

  it("requires both canonical Unity project markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-profile-"));
    roots.push(root);
    await mkdir(join(root, "Assets"));
    expect(await detectProjectKind(root)).toBe("generic");
    await mkdir(join(root, "ProjectSettings"));
    await writeFile(join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 2021.3.0f1\n");
    expect(await detectProjectKind(root)).toBe("unity");
    expect(await detectProjectKind(join(root, "Assets"))).toBe("unity");
    await mkdir(join(root, "Assets", "Scripts"));
    expect(await detectProjectKind(join(root, "Assets", "Scripts"))).toBe("unity");
  });
});
