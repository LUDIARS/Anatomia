/**
 * detectProjectKind must not treat every stat failure as "marker absent". Only
 * ENOENT/ENOTDIR mean absence; EACCES/EIO/etc. are real faults that would
 * otherwise misclassify the project (e.g. an unreadable Unity marker silently
 * falling through to the `generic` profile).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { statMock } = vi.hoisted(() => ({ statMock: vi.fn() }));
vi.mock("node:fs/promises", () => ({ stat: statMock }));

import { detectProjectKind } from "../profile.js";

afterEach(() => statMock.mockReset());

describe("detectProjectKind FS-error handling", () => {
  it("propagates a non-absent FS error (EACCES) instead of returning generic", async () => {
    statMock.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    await expect(detectProjectKind("/repo")).rejects.toThrow(/permission denied/);
  });

  it("treats ENOENT as a missing marker (generic)", async () => {
    statMock.mockRejectedValue(Object.assign(new Error("no entry"), { code: "ENOENT" }));
    await expect(detectProjectKind("/repo")).resolves.toBe("generic");
  });

  it("treats ENOTDIR as a missing marker (generic)", async () => {
    statMock.mockRejectedValue(Object.assign(new Error("not a dir"), { code: "ENOTDIR" }));
    await expect(detectProjectKind("/repo")).resolves.toBe("generic");
  });
});
