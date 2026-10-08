/**
 * @spec Source reference evidence
 */
import { describe, expect, it } from "vitest";
import { parse } from "../../dag/parser.js";
import { extractFunctions } from "../../dag/extract.js";
import { assignAnchorId } from "../../dag/hash.js";
import { normalize } from "../../dag/normalize.js";
import { buildFileNode } from "../../dag/merkle.js";
import { extractReferenceSyntax } from "../reference-syntax.js";
import { resolveReferenceEvidence } from "../reference-evidence.js";
import { buildGraph, extractEdgeInfo } from "../build.js";
import { localizeCachedGraph } from "../cache.js";
import type { FileNode } from "../../types.js";

async function fileOf(path: string, source: string): Promise<FileNode> {
  const tree = await parse(source, "typescript");
  try {
    const functions = extractFunctions(tree, source, path);
    for (const fn of functions) assignAnchorId(fn, normalize(fn.bodyAst!), path);
    const file = buildFileNode(path, functions);
    file.referenceSyntax = extractReferenceSyntax(tree, functions);
    for (const fn of functions) delete fn.bodyAst;
    return file;
  } finally { tree.delete(); }
}

describe("source reference evidence", () => {
  it("resolves constructors, imported aliases, callbacks and module-level calls after AST release", async () => {
    const definitions = await fileOf("/repo/contracts.ts", `
export class DiagnosticError { constructor() { this.name = "diagnostic"; } }
export function reference(value: string) { return value; }
export function startDiscordGateway() { return 1; }
export function requestFixture() { return 2; }
`);
    const facade = await fileOf("/repo/mechanics.ts", `export { DiagnosticError as MechanicsCheckError } from "./contracts.js";`);
    const uses = await fileOf("/repo/index.ts", `
import { MechanicsCheckError as aliasedMechanicsCheckError } from "./mechanics.js";
import { reference, startDiscordGateway, requestFixture } from "./contracts.js";
new aliasedMechanicsCheckError();
["doc"].map(reference);
startDiscordGateway();
const request = requestFixture();
`);
    const files = JSON.parse(JSON.stringify([definitions, facade, uses])) as FileNode[];
    const evidence = resolveReferenceEvidence(files);
    const names = new Map(definitions.functions.map((fn) => [fn.id, fn.name]));
    expect(evidence.map((entry) => [names.get(entry.target), entry.kind])).toEqual([
      ["constructor", "constructor"], ["reference", "callback-reference"],
      ["startDiscordGateway", "call"], ["requestFixture", "call"],
    ]);
    const graph = buildGraph(files, extractEdgeInfo(files));
    expect(graph.referenceEvidence).toEqual(evidence);
    expect(graph.edges).toEqual([]);
  });

  it("uses lexical scope and never treats shadowed, duplicate or unresolved names as positive evidence", async () => {
    const file = await fileOf("/repo/local.ts", `
function reference(x: string) { return x; }
class DiagnosticError { constructor() { this.name = "local"; } }
function parameter(reference: unknown) { [].map(reference); }
function destructured({reference}: {reference: unknown}) { [].map(reference); }
function block() { { const reference = external; [].map(reference); } }
function unknown() { const DiagnosticError = external; new DiagnosticError(); }
function duplicates() { function same() { return 1; } function same() { return 2; } [].map(same); }
import { remote } from "./missing.js";
remote();
new DiagnosticError();
[].map(reference);
`);
    const evidence = resolveReferenceEvidence([file]);
    expect(evidence).toHaveLength(2);
    expect(evidence.map((entry) => entry.kind)).toEqual(["constructor", "callback-reference"]);
  });

  it("does not manufacture usage from recursive self references or external/name-only matches", async () => {
    const file = await fileOf("/repo/definitions.ts", `function recursive() { return recursive(); } function absent() { return 1; }`);
    const other = await fileOf("/repo/other.ts", `absent();`);
    expect(resolveReferenceEvidence([file, other])).toEqual([]);
  });

  it("invalidates enclosing bindings written from child scopes and respects loop/parameter shadows", async () => {
    const file = await fileOf("/repo/mutations.ts", `
function target() { return 1; }
{ target = other; }
target();
function incremented() { return 1; }
{ incremented++; }
[].map(incremented);
function callback() { return 1; }
for (const callback of values) { [].map(callback); }
function optional(callback?: unknown) { [].map(callback); }
function rest(...callback: unknown[]) { [].map(callback); }
function arrow() { return ((callback: unknown) => { [].map(callback); }); }
`);
    expect(resolveReferenceEvidence([file])).toEqual([]);
  });

  it("localizes evidence onto current files for cached graphs", async () => {
    const file = await fileOf("/base/a.ts", `function target(x: unknown) { return x; } [].map(target);`);
    const graph = buildGraph([file], new Map());
    const current = { ...file, path: "/head/a.ts", functions: file.functions.map((fn) => ({
      ...fn, sourceRange: { ...fn.sourceRange, filePath: "/head/a.ts" },
    })) };
    const localized = localizeCachedGraph(graph, [current]);
    expect(localized).not.toBe(graph);
    expect(localized.referenceEvidence?.[0]?.file).toBe("/head/a.ts");
    expect(graph.referenceEvidence?.[0]?.file).toBe("/base/a.ts");
    expect(localized.edges).toBe(graph.edges);
  });

  it("retains graph identity with unchanged node and reference locations", async () => {
    const file = await fileOf("/repo/a.ts", `function target(x: unknown) { return x; } [].map(target);`);
    const graph = buildGraph([file], new Map());
    const equivalentFiles = JSON.parse(JSON.stringify([file])) as FileNode[];
    expect(localizeCachedGraph(graph, equivalentFiles)).toBe(graph);
  });

  it("clones for a reference-only location change without mutating the cached graph", async () => {
    const definitions = await fileOf("/repo/definitions.ts", `export function target(x: unknown) { return x; }`);
    const caller = await fileOf("/repo/caller.ts", `import { target } from "./definitions.js"; [].map(target);`);
    const graph = buildGraph([definitions, caller], new Map());
    const movedCaller: FileNode = { ...caller, referenceSyntax: { ...caller.referenceSyntax!,
      references: caller.referenceSyntax!.references.map((reference) => ({ ...reference, line: reference.line + 2 })) } };
    const localized = localizeCachedGraph(graph, [definitions, movedCaller]);
    expect(localized).not.toBe(graph);
    expect(localized.nodes).toBe(graph.nodes);
    expect(localized.referenceEvidence?.[0]?.line).toBe(2);
    expect(graph.referenceEvidence?.[0]?.line).toBe(0);
    expect(localized.edges).toBe(graph.edges);
  });

  it("keeps exact exports and calls when recovery is confined to erased import-type annotations", async () => {
    const gateway = await fileOf("/repo/gateway.ts", `
export function startDiscordGateway(config: import("./config.js").DiscutereConfig) { return 1; }
`);
    const index = await fileOf("/repo/index.ts", `
import { startDiscordGateway } from "./gateway.js";
startDiscordGateway(config);
`);
    const evidence = resolveReferenceEvidence([gateway, index]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.target).toBe(gateway.functions[0]!.id);
    expect(evidence[0]!.kind).toBe("call");
    expect(gateway.referenceSyntax!.scopes.some((scope) => scope.uncertain)).toBe(false);
  });

  it("blocks recovery scopes while retaining references in unrelated scopes", async () => {
    const file = await fileOf("/repo/recovery.ts", `
function reference(value: unknown) { return value; }
function broken() { const = 1; [].map(reference); }
function intact() { [].map(reference); }
[].map(reference);
`);
    expect(file.referenceSyntax!.scopes.some((scope) => scope.uncertain)).toBe(true);
    const evidence = resolveReferenceEvidence([file]);
    expect(evidence).toHaveLength(2);
    expect(evidence.map((entry) => entry.line)).toEqual([3, 4]);
    const moduleError = await fileOf("/repo/module-error.ts", `
const = 1;
export function reference(value: unknown) { return value; }
[].map(reference);
`);
    expect(moduleError.referenceSyntax!.scopes[0]!.uncertain).toBe(true);
    expect(resolveReferenceEvidence([moduleError])).toEqual([]);
    const consumer = await fileOf("/repo/consumer.ts", `import { reference } from "./module-error.js"; [].map(reference);`);
    expect(resolveReferenceEvidence([moduleError, consumer])).toEqual([]);
  });
});
