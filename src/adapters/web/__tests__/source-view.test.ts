/**
 * ドメインから Tela / Web でコードを見る (Actio c5aaf3e3 + neco 2026-10-13 「Webで指定のコードをビジュアライズ」).
 *
 * 境界: 相対パスだけを受け、登録リポの外 (`..`・絶対パス) を開かない / 日本語と空白を含む
 * パスを 1 引数で渡す / 存在しないファイル・範囲外の行・解析後の変更を利用者が選べる失敗にする /
 * ビューア未構成・別端末からの要求では起動しない / シェルを介さない。
 */

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnalysisContext } from "../../../core.js";
import type { AnchorId, CodeNode, FunctionNode } from "../../../types.js";
import type { WebContextSource } from "../context.js";
import { mountSourceViewRoutes } from "../routes/source-view.js";
import { buildSourceViewContent, splitSourceLines } from "../source-view-content.js";
import { sourceViewCandidates } from "../source-view-candidates.js";
import { loadSourceViewerConfig, sourceViewerArgs, type SpawnLike } from "../source-view-launch.js";
import { classifyLaunchRequest } from "../source-view-request.js";
import { countLines, resolveSourceTarget } from "../source-view-target.js";
import {
  actionLabel, candidateLabel, codeRows, contentQuery, launchBody, launchOutcome, pageLine, viewerChoices,
} from "../public/source-view-logic.js";

let root: string;
let repo: string;
const JP_FILE = "src/日本語 フォルダ/画面.ts";
const JP_SOURCE = "export function show() {\n  return helper();\n}\nfunction helper() {\n  return 1;\n}\n";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "anatomia-source-view-"));
  repo = join(root, "repo");
  await mkdir(join(repo, "src", "日本語 フォルダ"), { recursive: true });
  await writeFile(join(repo, JP_FILE), JP_SOURCE, "utf8");
  await writeFile(join(repo, "src", "crlf.ts"), "a\r\nb\r\nc", "utf8");
  await writeFile(join(repo, "src", "binary.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  await writeFile(join(root, "secret.txt"), "outside", "utf8");
  await writeFile(join(root, "tela_source.exe"), "", "utf8");
  await writeFile(join(root, "mono.ttf"), "", "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function fn(id: string, name: string, file: string, start: number, end: number): FunctionNode {
  return {
    id: id as AnchorId,
    name,
    signature: `${name}()`,
    sourceRange: { start: { line: start - 1, column: 0 }, end: { line: end - 1, column: 1 }, filePath: join(repo, file) },
  };
}

function context(contentHash?: string): AnalysisContext {
  const show = fn("show", "show", JP_FILE, 1, 3);
  const helper = fn("helper", "helper", JP_FILE, 4, 6);
  const node = (f: FunctionNode): CodeNode => ({ id: f.id!, name: f.name, kind: "function", sourceRange: f.sourceRange });
  return {
    repoPath: repo,
    files: [{ path: join(repo, JP_FILE), hash: null, functions: [show, helper], ...(contentHash ? { contentHash } : {}) }],
    functions: [show, helper],
    domains: [{ domain: "presentation", implementors: ["helper", "show", "show"], violations: [] }],
    graph: {
      predecessors: async (id: AnchorId) => (id === "helper" ? [node(show)] : []),
      neighbors: async (id: AnchorId) => (id === "show" ? [node(helper)] : []),
    },
  } as unknown as AnalysisContext;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("resolveSourceTarget", () => {
  it("accepts a repo-relative path with Japanese and spaces and validates the line", async () => {
    const result = await resolveSourceTarget({ repoPath: repo, file: JP_FILE, line: 2, analyzedContentHash: sha(JP_SOURCE) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.file).toBe(JP_FILE);
    expect(result.target.lineCount).toBe(6);
    expect(result.target.stale).toBe(false);
  });

  it("refuses paths that escape the repository, absolute paths and malformed input", async () => {
    for (const file of ["../secret.txt", "src/../../secret.txt", join(root, "secret.txt"), "", "a\0b"]) {
      const result = await resolveSourceTarget({ repoPath: repo, file, line: 1 });
      expect(result.ok).toBe(false);
    }
    expect(await resolveSourceTarget({ repoPath: repo, file: "../secret.txt", line: 1 }))
      .toMatchObject({ ok: false, reason: "outside-repository" });
    expect(await resolveSourceTarget({ repoPath: repo, file: JP_FILE, line: 0 }))
      .toMatchObject({ ok: false, reason: "invalid-request" });
  });

  it("reports a missing file, a line past the end and a file changed after analysis", async () => {
    expect(await resolveSourceTarget({ repoPath: repo, file: "src/gone.ts", line: 1 }))
      .toMatchObject({ ok: false, reason: "missing-file" });
    expect(await resolveSourceTarget({ repoPath: repo, file: JP_FILE, line: 99 }))
      .toMatchObject({ ok: false, reason: "line-out-of-range" });
    const stale = await resolveSourceTarget({ repoPath: repo, file: JP_FILE, line: 1, analyzedContentHash: sha("old") });
    expect(stale.ok && stale.target.stale).toBe(true);
  });

  it("counts lines like Tela's reader (CRLF, LF, bare CR, empty file)", () => {
    expect(countLines("")).toBe(1);
    expect(countLines("a\r\nb\r\nc")).toBe(3);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\rb")).toBe(2);
    expect(splitSourceLines("a\r\nb\rc\n")).toEqual(["a", "b", "c"]);
  });
});

describe("source viewer launch configuration", () => {
  it("is not configured without both the viewer and the font, and never guesses a path", async () => {
    expect(await loadSourceViewerConfig({})).toMatchObject({ ok: false, reason: "not-configured" });
    expect(await loadSourceViewerConfig({ ANATOMIA_TELA_SOURCE_BIN: join(root, "nope.exe"), ANATOMIA_TELA_FONT: join(root, "mono.ttf") }))
      .toMatchObject({ ok: false, reason: "viewer-missing" });
    expect(await loadSourceViewerConfig({ ANATOMIA_TELA_SOURCE_BIN: join(root, "tela_source.exe"), ANATOMIA_TELA_FONT: join(root, "none.ttf") }))
      .toMatchObject({ ok: false, reason: "font-missing" });
  });

  it("passes the path as one argument of an argument array", () => {
    const args = sourceViewerArgs(
      { bin: "tela_source", font: "/opt/fonts/mono.ttf", fontSize: 18 },
      { absolutePath: "/srv/repo/src/日本語 フォルダ/画面.ts", file: JP_FILE, line: 2, lineCount: 6, stale: false },
    );
    expect(args).toEqual(["--font", "/opt/fonts/mono.ttf", "--font-size", "18", "--source", "/srv/repo/src/日本語 フォルダ/画面.ts", "--line", "2"]);
  });
});

describe("classifyLaunchRequest", () => {
  const headers = (map: Record<string, string>) => (name: string) => map[name];
  it("allows only a direct local request", () => {
    expect(classifyLaunchRequest({ remoteAddress: "127.0.0.1", header: headers({ host: "127.0.0.1:4200" }) })).toEqual({ local: true });
    expect(classifyLaunchRequest({ remoteAddress: "::ffff:127.0.0.1", header: headers({ host: "localhost:4200", origin: "http://localhost:4200" }) })).toEqual({ local: true });
  });
  it("treats another device, a forwarding proxy and a cross-origin page as remote", () => {
    expect(classifyLaunchRequest({ remoteAddress: "203.0.113.10", header: headers({}) })).toMatchObject({ local: false, reason: "remote-client" });
    expect(classifyLaunchRequest({ remoteAddress: "127.0.0.1", header: headers({ "x-forwarded-for": "198.51.100.2" }) })).toMatchObject({ local: false, reason: "forwarded" });
    expect(classifyLaunchRequest({ remoteAddress: "127.0.0.1", header: headers({ "cf-connecting-ip": "203.0.113.4" }) })).toMatchObject({ local: false, reason: "forwarded" });
    expect(classifyLaunchRequest({ remoteAddress: "127.0.0.1", header: headers({ host: "127.0.0.1:4200", origin: "https://evil.example" }) })).toMatchObject({ local: false, reason: "cross-origin" });
  });
});

describe("source-view routes", () => {
  const env = { ANATOMIA_TELA_SOURCE_BIN: "", ANATOMIA_TELA_FONT: "" };
  function appWith(options: { remote?: string; env?: NodeJS.ProcessEnv; contentHash?: string; spawn?: SpawnLike } = {}) {
    const app = new Hono();
    const ctx = context(options.contentHash);
    const source = { resolve: async () => ctx } as unknown as WebContextSource;
    mountSourceViewRoutes(app, source, {
      env: options.env ?? env,
      remoteAddress: () => options.remote ?? "127.0.0.1",
      ...(options.spawn ? { spawn: options.spawn } : {}),
    });
    return app;
  }
  const launch = (app: Hono, body: unknown, headers: Record<string, string> = {}) =>
    app.request("/api/projects/p/source-view/launch", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("lists every implementor once, sorted by location", async () => {
    const res = await appWith().request("/api/projects/p/source-view/candidates?domain=presentation");
    const body = await res.json();
    expect(body.candidates.map((c: { name: string; line: number }) => `${c.name}:${c.line}`)).toEqual(["show:1", "helper:4"]);
    expect(sourceViewCandidates(context(), "missing")).toMatchObject({ ok: false, reason: "unknown-domain" });
  });

  it("launches tela_source without a shell for a local request", async () => {
    const calls: Array<{ command: string; args: string[]; shell: unknown }> = [];
    const spawn: SpawnLike = (command, args, options) => {
      calls.push({ command, args, shell: options.shell });
      return { once(event: string, listener: () => void) { if (event === "spawn") setTimeout(listener, 0); }, unref() {} } as ReturnType<SpawnLike>;
    };
    const app = appWith({
      spawn,
      contentHash: sha(JP_SOURCE),
      env: { ANATOMIA_TELA_SOURCE_BIN: join(root, "tela_source.exe"), ANATOMIA_TELA_FONT: join(root, "mono.ttf") },
    });
    const res = await launch(app, { file: JP_FILE, line: 2 });
    expect(await res.json()).toEqual({ ok: true, file: JP_FILE, line: 2, stale: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.shell).toBe(false);
    expect(calls[0]!.args.slice(-2)).toEqual(["--line", "2"]);
    expect(calls[0]!.args[calls[0]!.args.indexOf("--source") + 1]).toContain("画面.ts");
  });

  it("refuses a remote request, keeping the file and line visible", async () => {
    const res = await launch(appWith({ remote: "203.0.113.20" }), { file: JP_FILE, line: 2 });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, reason: "remote-client", file: JP_FILE, line: 2 });
  });

  it("asks before opening a file changed after analysis, and reports an unconfigured viewer", async () => {
    const stale = await launch(appWith({ contentHash: sha("old") }), { file: JP_FILE, line: 2 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ reason: "stale" });
    const unconfigured = await launch(appWith({ contentHash: sha("old") }), { file: JP_FILE, line: 2, acceptStale: true });
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({ reason: "not-configured", file: JP_FILE, line: 2 });
  });

  it("serves the web view with the enclosing function and its callers / callees", async () => {
    const res = await appWith({ contentHash: sha(JP_SOURCE) }).request(`/api/projects/p/source-view/content?${contentQuery(JP_FILE, 5)}`);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, file: JP_FILE, line: 5, start: 1, lineCount: 6, stale: false });
    expect(body.lines).toHaveLength(6);
    expect(body.enclosing).toMatchObject({ name: "helper", startLine: 4, endLine: 6 });
    expect(body.enclosing.callers.map((p: { name: string }) => p.name)).toEqual(["show"]);
  });

  it("refuses a non-UTF-8 file and a path outside the repository in the web view", async () => {
    const binary = await appWith().request(`/api/projects/p/source-view/content?${contentQuery("src/binary.bin", 1)}`);
    expect(await binary.json()).toMatchObject({ ok: false, reason: "not-utf8" });
    const outside = await appWith().request(`/api/projects/p/source-view/content?${contentQuery("../secret.txt", 1)}`);
    expect(outside.status).toBe(422);
    expect(await outside.json()).toMatchObject({ reason: "outside-repository" });
  });
});

describe("buildSourceViewContent", () => {
  it("windows a CRLF file without changing line numbers", async () => {
    const target = await resolveSourceTarget({ repoPath: repo, file: "src/crlf.ts", line: 3 });
    if (!target.ok) throw new Error(target.message);
    const result = await buildSourceViewContent(context(), target.target);
    expect(result.ok && result.content.lines).toEqual(["a", "b", "c"]);
  });
});

describe("source-view panel logic", () => {
  it("labels candidates and builds the launch body", () => {
    expect(candidateLabel({ name: "run", enclosingType: "Scene", file: "a.ts", line: 3 })).toBe("a.ts:3  Scene.run");
    expect(launchBody({ file: "a.ts", line: 3 }, true)).toEqual({ file: "a.ts", line: 3, acceptStale: true });
  });

  it("offers Tela only on a machine where it is installed, and never asks to set it up", () => {
    const missing = viewerChoices({ configured: false, local: true, message: "Tela ソースビューアが未構成です。" });
    expect(missing).toEqual({ tela: false, note: null });
    expect(viewerChoices(undefined)).toEqual({ tela: false, note: null });
    expect(viewerChoices({ configured: true, local: true })).toEqual({ tela: true, note: null });
    // Installed, but this browser is not on the server PC: say why Tela will not open here.
    expect(viewerChoices({ configured: true, local: false, message: "別の端末からは開けません。" }))
      .toEqual({ tela: true, note: "別の端末からは開けません。" });
  });

  it("offers next steps that match each refusal", () => {
    expect(launchOutcome({ ok: false, reason: "stale", file: "a.ts", line: 3 }).actions).toEqual(["open-anyway", "reanalyze"]);
    expect(launchOutcome({ ok: false, reason: "line-out-of-range" }).actions).toEqual(["open-first-line", "reanalyze"]);
    expect(launchOutcome({ ok: false, reason: "remote-client", message: "x", file: "a.ts", line: 3 })).toMatchObject({ tone: "error", location: "a.ts:3", actions: [] });
    expect(launchOutcome({ ok: true, file: "a.ts", line: 3, stale: true }).tone).toBe("warn");
    expect(actionLabel("open-anyway")).toBe("現在の内容で開く");
  });

  it("marks the requested line and the enclosing function, and pages by window", () => {
    const content = { file: "a.ts", line: 3, lineCount: 200, start: 2, lines: ["b", "c", "d"], enclosing: { startLine: 3, endLine: 4 } };
    expect(codeRows(content)).toEqual([
      { number: 2, text: "b", target: false, inFunction: false },
      { number: 3, text: "c", target: true, inFunction: true },
      { number: 4, text: "d", target: false, inFunction: true },
    ]);
    expect(pageLine(content, "prev")).toBe(1);
    expect(pageLine(content, "next")).toBe(5);
  });
});
