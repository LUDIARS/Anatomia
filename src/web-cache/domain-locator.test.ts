import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisContext } from "../core.js";
import type { BusinessDomainViewPayload, ProgramDomainViewPayload } from "./types.js";
import { buildDomainLocator } from "./domain-locator.js";
import { DomainLocatorError, findPreparedFunction, listPreparedDomains, listPreparedFunctions, writeDomainLocator } from "./domain-locator-store.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("prepared domain locator", () => {
  it("preserves approved business evidence, distinct occurrences, and program-only domains", async () => {
    const root = await mkdtemp(join(tmpdir(), "an-locator-")); dirs.push(root);
    const ctx = { repoPath: root, functions: [
      { id: "anchor-1", name: "place", sourceRange: { filePath: join(root, "a.ts"), start: { line: 4 } } },
      { id: "anchor-1", name: "place", sourceRange: { filePath: join(root, "b.ts"), start: { line: 8 } } },
    ] } as unknown as AnalysisContext;
    const business = { domains: [
      { id: "business:orders", name: "Orders", specRefs: [{ id: "spec:checkout" }], programDomains: [{ codeSymbols: [{ id: "code-symbol:durable", file: "a.ts", line: 4 }] }] },
      { id: "business:spec-only", name: "Policy", specRefs: [], programDomains: [] },
    ] } as unknown as BusinessDomainViewPayload;
    const program = { layers: [{ domains: [
      { id: "program:core", codeSymbolIds: ["anchor-1"], businessDomains: [] },
    ] }] } as unknown as ProgramDomainViewPayload;
    const build = buildDomainLocator(ctx, business, program, new Map([[`a.ts\0${4}`, "Place an order"]]));
    expect(build.domains.find((row) => row.id === "business:orders")?.functions).toEqual([
      expect.objectContaining({ path: "a.ts", line: 4, comment: "Place an order", specRefs: ["spec:checkout"] }),
    ]);
    expect(build.domains.find((row) => row.id === "program:core")?.functionCount).toBe(2);
    expect(build.domains.find((row) => row.id === "business:spec-only")?.functionCount).toBe(0);

    await writeDomainLocator(root, "project", "fingerprint", "2026-09-27T00:00:00Z", build);
    expect((await listPreparedDomains(root)).domains).toHaveLength(3);
    const first = await listPreparedFunctions(root, "program:core", 1);
    expect(first).toMatchObject({ total: 2, truncated: true, freshness: "unchecked" });
    expect((await listPreparedFunctions(root, "program:core", 1, 1)).functions).toHaveLength(1);
    expect((await listPreparedFunctions(root, "program:core", 50, 0, "program", "place")).total).toBe(2);
    const reverse = await findPreparedFunction(root, "anchor-1");
    expect(reverse.domains).toHaveLength(2);
    expect(reverse.functions).toHaveLength(2);
    expect(reverse.functions.find((row) => row.path === "a.ts")?.specRefs).toEqual(["spec:checkout"]);
    // A corrupt unrelated shard cannot affect a first query for the selected domain.
    const pointer = JSON.parse(await readFile(join(root, "domain-locator", "current.json"), "utf8")) as { generation: string };
    const catalog = await listPreparedDomains(root);
    const unrelated = catalog.domains.find((row) => row.id === "business:spec-only")!;
    await writeFile(join(root, "domain-locator", pointer.generation, unrelated.shard), "null", "utf8");
    expect((await listPreparedFunctions(root, "program:core")).total).toBe(2);
    await expect(listPreparedFunctions(root, "business:spec-only")).rejects.toMatchObject({ code: "prepare-required" });
  });

  it("reports missing and corrupt data and keeps the preceding published generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "an-locator-")); dirs.push(root);
    await expect(listPreparedDomains(root)).rejects.toMatchObject({ code: "prepare-required" } satisfies Partial<DomainLocatorError>);
    const build = { domains: [{ id: "same", layer: "business" as const, name: "B", functionCount: 0, functions: [] },
      { id: "same", layer: "program" as const, name: "P", functionCount: 0, functions: [] }] };
    await writeDomainLocator(root, "p", "f1", "t1", build);
    await expect(listPreparedFunctions(root, "same")).rejects.toMatchObject({ code: "domain-not-found" });
    expect((await listPreparedFunctions(root, "same", 5, 0, "program")).domain.layer).toBe("program");
    const old = JSON.parse(await readFile(join(root, "domain-locator", "current.json"), "utf8")) as { generation: string };
    await writeDomainLocator(root, "p", "f2", "t2", build);
    expect((await listPreparedDomains(root)).fingerprint).toBe("f2");
    expect((await readFile(join(root, "domain-locator", old.generation, "catalog.json"), "utf8")).includes("f1")).toBe(true);
    await writeFile(join(root, "domain-locator", "current.json"), "null", "utf8");
    await expect(listPreparedDomains(root)).rejects.toMatchObject({ code: "prepare-required" });
  });
});
