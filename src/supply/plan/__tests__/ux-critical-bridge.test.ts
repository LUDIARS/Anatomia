import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { knowledgeLogPathFor } from "../ux-critical-bridge.js";

describe("knowledgeLogPathFor", () => {
  it("uses a registered knowledge write root instead of assuming <repo>/spec", () => {
    expect(knowledgeLogPathFor("/repo/src", "fixture", "/repo/knowledge"))
      .toBe(join("/repo/knowledge", "data", "domain-map", "fixture.knowledge.jsonl"));
  });
});
