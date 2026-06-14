/**
 * Tests for T21 — parse.ts
 */

import { describe, it, expect, afterEach } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMdFile, parseSpecFiles, slugify } from "./parse.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP = tmpdir();
const tempFiles: string[] = [];

async function writeTmp(name: string, content: string): Promise<string> {
  const p = join(TMP, name);
  await writeFile(p, content, "utf8");
  tempFiles.push(p);
  return p;
}

afterEach(async () => {
  await Promise.allSettled(tempFiles.map((f) => unlink(f)));
  tempFiles.length = 0;
});

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });
  it("strips non-word characters leaving ascii digits and letters", () => {
    // section symbol, dots, slashes, and CJK chars are all stripped
    expect(slugify("Section 4.5")).toBe("section-45");
  });
});

// ---------------------------------------------------------------------------
// parseMdFile
// ---------------------------------------------------------------------------

describe("parseMdFile", () => {
  it("parses a file with 3 top-level headings into 3 clauses", async () => {
    const p = await writeTmp("three-headings.md", [
      "# Alpha",
      "Text under alpha.",
      "",
      "# Beta",
      "Text under beta.",
      "",
      "# Gamma",
      "Text under gamma.",
    ].join("\n"));

    const clauses = await parseMdFile(p);
    expect(clauses).toHaveLength(3);
    expect(clauses[0].heading).toBe("Alpha");
    expect(clauses[1].heading).toBe("Beta");
    expect(clauses[2].heading).toBe("Gamma");
  });

  it("builds nested heading path like 'Parent / Child / GrandChild'", async () => {
    const p = await writeTmp("nested.md", [
      "# Parent",
      "## Child",
      "### GrandChild",
      "deep content",
    ].join("\n"));

    const clauses = await parseMdFile(p);
    // We expect at least 3 clauses: Parent, Child, GrandChild
    expect(clauses.length).toBeGreaterThanOrEqual(3);

    const grandChild = clauses.find((c) => c.heading.includes("GrandChild"));
    expect(grandChild).toBeDefined();
    expect(grandChild!.heading).toBe("Parent / Child / GrandChild");
  });

  it("captures text under each heading", async () => {
    const p = await writeTmp("text-capture.md", [
      "# Section",
      "Line one.",
      "Line two.",
    ].join("\n"));

    const clauses = await parseMdFile(p);
    expect(clauses).toHaveLength(1);
    expect(clauses[0].text).toContain("Line one.");
    expect(clauses[0].text).toContain("Line two.");
  });

  it("returns deterministic IDs across two parses of the same file", async () => {
    const p = await writeTmp("deterministic.md", [
      "# Foo",
      "bar",
      "# Baz",
      "qux",
    ].join("\n"));

    const first = await parseMdFile(p);
    const second = await parseMdFile(p);

    expect(first.map((c) => c.id)).toEqual(second.map((c) => c.id));
  });

  it("uses the explicit sourceFile param for IDs and clause.sourceFile", async () => {
    const p = await writeTmp("source-param.md", "# H1\ncontent");
    const clauses = await parseMdFile(p, "spec/my-doc.md");
    expect(clauses[0].sourceFile).toBe("spec/my-doc.md");
  });

  it("sets embedding to null", async () => {
    const p = await writeTmp("emb-null.md", "# X\ncontent");
    const clauses = await parseMdFile(p);
    expect(clauses[0].embedding).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseSpecFiles
// ---------------------------------------------------------------------------

describe("parseSpecFiles", () => {
  it("aggregates clauses from multiple files", async () => {
    const p1 = await writeTmp("multi-1.md", "# A\ntext a");
    const p2 = await writeTmp("multi-2.md", "# B\ntext b\n# C\ntext c");

    const clauses = await parseSpecFiles([p1, p2]);
    expect(clauses).toHaveLength(3);
    const headings = clauses.map((c) => c.heading);
    expect(headings).toContain("A");
    expect(headings).toContain("B");
    expect(headings).toContain("C");
  });
});
