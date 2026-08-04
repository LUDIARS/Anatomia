import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeFingerprint, resetFingerprintMemo } from "../project/fingerprint.js";

const roots: string[] = [];
afterEach(async () => {
  resetFingerprintMemo();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("knowledge source fingerprint", () => {
  it("excludes generated output while retaining authored knowledge", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-source-fingerprint-"));
    roots.push(root);
    const generated = join(root, "spec", "data", "generated", "anatomia");
    const domains = join(root, "spec", "data", "domains");
    await mkdir(generated, { recursive: true });
    await mkdir(domains, { recursive: true });
    await writeFile(join(root, "source.ts"), "export const x = 1;\n", "utf8");
    await writeFile(join(generated, "scene.md"), "generated one\n", "utf8");
    await writeFile(join(domains, "combat.md"), "authored one\n", "utf8");
    const options = { configDirs: [join(root, "spec")], excludeDirs: [generated] };
    const first = await computeFingerprint(root, options);

    await writeFile(join(generated, "scene.md"), "generated output changed substantially\n", "utf8");
    resetFingerprintMemo();
    expect(await computeFingerprint(root, options)).toBe(first);

    await writeFile(join(domains, "combat.md"), "authored knowledge changed substantially\n", "utf8");
    resetFingerprintMemo();
    expect(await computeFingerprint(root, options)).not.toBe(first);
  });
});
