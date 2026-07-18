import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("web graph view toggle", () => {
  it("offers function/class modes and maps branch diff anchors through collapsed members", async () => {
    const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
    expect(html).toContain('id="graph-view-function"');
    expect(html).toContain('id="graph-view-class"');
    expect(html).toContain("payload.defaultView || 'function'");
    expect(html).toContain("n._meta.memberAnchors");
  });
});
