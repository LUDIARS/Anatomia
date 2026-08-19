/**
 * FileAnalysisDiskCache — gzip-JSON per-file entries, keyed by path + content
 * hash, degrading to a miss on anything unexpected.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { FileAnalysisDiskCache } from "../file-cache.js";
import type { AnchorId, FileNode } from "../../types.js";

let dir: string;

const sampleFile = (path: string): FileNode => ({
  path,
  hash: null,
  contentHash: "c".repeat(64),
  templateKeys: ["cpp\0$SKILL.mutate($STATE)"],
  functions: [
    {
      id: "deadbeefdeadbeef" as AnchorId,
      name: "f",
      signature: "int f(int)",
      sourceRange: { start: { line: 1, column: 0 }, end: { line: 1, column: 30 }, filePath: path },
      edgeInfo: {
        anchorId: "deadbeefdeadbeef" as AnchorId,
        calls: [{ name: "g", receiver: null }],
        readFieldNames: [],
        writeFieldNames: [],
        symbolTypes: {},
        containerElem: {},
        callLocals: [],
        rangeFors: [],
      },
      templateMatches: { "cpp\0$SKILL.mutate($STATE)": null },
      // A live-looking mirror that MUST be stripped on write (also guards the
      // JSON.stringify cycle its parent link would cause).
      bodyAst: (() => {
        const node: Record<string, unknown> = { type: "compound_statement", text: "{}" };
        node.parent = node;
        return node as unknown as FileNode["functions"][number]["bodyAst"];
      })(),
    },
  ],
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anatomia-filecache-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FileAnalysisDiskCache", () => {
  it("round-trips a FileNode with bodyAst stripped", async () => {
    const cache = new FileAnalysisDiskCache(dir);
    const path = join(dir, "src", "x.cpp");
    const file = sampleFile(path);
    file.contentHash = "a".repeat(64);
    await cache.set(path, "a".repeat(64), file);

    const loaded = await cache.get(path, "a".repeat(64));
    expect(loaded).not.toBeNull();
    expect(loaded!.functions[0]!.bodyAst).toBeUndefined();
    expect(loaded!.functions[0]!.edgeInfo?.calls[0]?.name).toBe("g");
    expect(loaded!.functions[0]!.templateMatches).toEqual(file.functions[0]!.templateMatches);
    expect(loaded!.templateKeys).toEqual(file.templateKeys);
  });

  it("misses on a different content hash or path", async () => {
    const cache = new FileAnalysisDiskCache(dir);
    const path = join(dir, "x.cpp");
    const file = sampleFile(path);
    file.contentHash = "a".repeat(64);
    await cache.set(path, "a".repeat(64), file);

    expect(await cache.get(path, "b".repeat(64))).toBeNull();
    expect(await cache.get(join(dir, "y.cpp"), "a".repeat(64))).toBeNull();
  });

  it("misses (not throws) on a corrupt entry", async () => {
    const cache = new FileAnalysisDiskCache(dir);
    const path = join(dir, "x.cpp");
    const file = sampleFile(path);
    file.contentHash = "a".repeat(64);
    await cache.set(path, "a".repeat(64), file);

    // Corrupt every stored entry in place.
    for (const shard of await readdir(dir)) {
      for (const name of await readdir(join(dir, shard))) {
        await writeFile(join(dir, shard, name), "not gzip");
      }
    }
    expect(await cache.get(path, "a".repeat(64))).toBeNull();
  });

  it("misses on valid gzip JSON with an invalid FileNode shape", async () => {
    const cache = new FileAnalysisDiskCache(dir);
    const path = join(dir, "x.cpp");
    const file = sampleFile(path);
    file.contentHash = "a".repeat(64);
    await cache.set(path, "a".repeat(64), file);

    const shard = (await readdir(dir))[0]!;
    const name = (await readdir(join(dir, shard)))[0]!;
    const entryPath = join(dir, shard, name);
    const entry = JSON.parse(gunzipSync(await readFile(entryPath)).toString("utf8"));
    entry.file.functions = [null];
    await writeFile(entryPath, gzipSync(JSON.stringify(entry)));

    expect(await cache.get(path, "a".repeat(64))).toBeNull();
  });
});
