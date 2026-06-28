/**
 * computeFingerprint — the fingerprint is content-addressed, not stamp-based.
 *
 * These pin the two behaviours the {size, mtimeMs} fingerprint got wrong:
 *   - a pure mtime change (git checkout / pull / rebase / fresh worktree rewrites
 *     mtimes without changing content) must NOT flip the fingerprint, so the
 *     analysis cache survives a touch that changed nothing;
 *   - a content edit that preserves a file's byte size MUST flip the fingerprint,
 *     so a stale context is never served (the old stamp hash could miss this).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeFingerprint, resetFingerprintMemo } from "../fingerprint.js";

let root: string;

beforeEach(async () => {
  resetFingerprintMemo();
  root = await mkdtemp(join(tmpdir(), "anatomia-fp-content-"));
  await writeFile(join(root, "a.ts"), "export const a = 1;\n");
});

afterEach(async () => {
  resetFingerprintMemo();
  await rm(root, { recursive: true, force: true });
});

describe("computeFingerprint content-addressing", () => {
  it("is stable when only mtime changes (git checkout / fresh worktree)", async () => {
    const before = await computeFingerprint(root);
    // Bump mtime far into the past without touching content — what a checkout does.
    const past = new Date("2020-01-01T00:00:00Z");
    await utimes(join(root, "a.ts"), past, past);
    resetFingerprintMemo(); // force a re-read so content (not the memo) drives it
    const after = await computeFingerprint(root);
    expect(after).toBe(before);
  });

  it("changes when content changes but the byte size is identical", async () => {
    const before = await computeFingerprint(root);
    // Same byte length as the original, so a size+mtime stamp could collide.
    await writeFile(join(root, "a.ts"), "export const a = 2;\n");
    resetFingerprintMemo();
    const after = await computeFingerprint(root);
    expect(after).not.toBe(before);
  });

  it("is deterministic for identical content", async () => {
    const a = await computeFingerprint(root);
    resetFingerprintMemo();
    const b = await computeFingerprint(root);
    expect(a).toBe(b);
  });
});
