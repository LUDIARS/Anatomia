import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "../knowledge/types.js";
import { prepareDomainCorrespondenceWebCache, readDomainCorrespondenceWebCache } from "./domain-correspondence.js";

let directory: string;

beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "anatomia-domain-correspondence-")); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe("domain correspondence web cache", () => {
  it("prepares the query projection once and reads it without source replay", async () => {
    const revision = { sourceRevision: "r1", contentFingerprint: "x", sourcePath: "src/a.ts", sourceRange: { startLine: 1, endLine: 1 } };
    const state: KnowledgeGraph = {
      head: null,
      transactions: [],
      nodes: new Map([
        ["business:a", { id: "business:a", kind: "domain", revision }],
        ["program:a", { id: "program:a", kind: "program-domain", revision }],
        ["code:a", { id: "code:a", kind: "code-symbol", revision }],
      ]),
      edges: new Map([
        ["contains", { id: "contains", kind: "program-domain-contains-code", from: "program:a", to: "code:a" }],
        ["owns", { id: "owns", kind: "domain-owns-code", from: "business:a", to: "code:a" }],
      ]),
    };
    const prepared = await prepareDomainCorrespondenceWebCache(directory, state);
    state.edges.clear();
    expect(await readDomainCorrespondenceWebCache(directory)).toEqual(prepared);
  });

  it("returns null when no correspondence cache has been prepared", async () => {
    expect(await readDomainCorrespondenceWebCache(join(directory, "absent"))).toBeNull();
  });
});
