import { describe, expect, it } from "vitest";

import { isVgLogWriteFailure, vestigiumDisabledNotice } from "./vestigium.js";

/**
 * Anatomia CLI を子プロセスで叩く委託エージェントは stderr を見て実行可否を判断する。
 * 観測ログ (Vg) を諦めただけの通知が複数行のスタックトレースに見えると、 exit code 0 と
 * stdout の landings JSON を無視して「CLI 使用不能」と誤判定する (Memoria #1754 / #1770)。
 */
describe("vestigiumDisabledNotice", () => {
  it("MODULE_NOT_FOUND の Require stack を落として 1 行にする", () => {
    const error = new Error(
      [
        "Cannot find module '@ludiars/vestigium'",
        "Require stack:",
        "- <repo>/dist/obs/vestigium.js",
      ].join("\n"),
    );

    const notice = vestigiumDisabledNotice(error);

    expect(notice.split("\n")).toHaveLength(1);
    expect(notice).toContain("Cannot find module '@ludiars/vestigium'");
    expect(notice).not.toContain("Require stack");
    expect(notice).not.toContain("<repo>");
  });

  it("解析が続いていることが読み取れる文言にする", () => {
    expect(vestigiumDisabledNotice(new Error("EACCES: permission denied")))
      .toBe("[anatomia/vestigium] Vg ログ無効 (解析は継続): EACCES: permission denied");
  });

  it.each(["\r", "\n", "\u2028", "\u2029"])("改行 %j 以降を落とす", (separator) => {
    const notice = vestigiumDisabledNotice(`boom${separator}second line`);

    expect(notice).toBe("[anatomia/vestigium] Vg ログ無効 (解析は継続): boom");
  });

  it("制御文字による stderr の装飾を除く", () => {
    expect(vestigiumDisabledNotice("permission\u001b[31m denied"))
      .toBe("[anatomia/vestigium] Vg ログ無効 (解析は継続): permission [31m denied");
  });

  it("文字列化できない値でも通知の生成を失敗させない", () => {
    const value = { toString: () => { throw new Error("cannot stringify"); } };

    expect(vestigiumDisabledNotice(value))
      .toBe("[anatomia/vestigium] Vg ログ無効 (解析は継続): unknown error");
  });
});

/**
 * 並行する委託が同じ日付の JSONL へ追記すると、 Vg の WriteStream (error listener 無し) の
 * EPERM が uncaughtException として届き、 解析ごと exit 1 になっていた (Actio 0317cf25)。
 * Vg 由来と言えるものだけをログ無効化に回し、 それ以外の障害は従来どおり crash させる。
 */
describe("isVgLogWriteFailure", () => {
  const logsDir = "C:/work/logs";
  const fsError = (code: string, path?: string) => Object.assign(new Error(code), { code, path });

  it("logsDir 配下への書き込み失敗は Vg 由来とみなす", () => {
    expect(isVgLogWriteFailure(fsError("EPERM", "C:/work/logs/anatomia/2026-09-04.jsonl"), logsDir)).toBe(true);
    expect(isVgLogWriteFailure(fsError("EBUSY", "C:\\work\\logs\\anatomia\\2026-09-04.jsonl"), logsDir)).toBe(true);
  });

  it("logsDir の外・同じ接頭辞の別ディレクトリは Vg 由来としない", () => {
    expect(isVgLogWriteFailure(fsError("EPERM", "C:/work/cache/graph.bin"), logsDir)).toBe(false);
    expect(isVgLogWriteFailure(fsError("EPERM", "C:/work/logs-old/anatomia.jsonl"), logsDir)).toBe(false);
  });

  it("ファイルシステム以外のエラー・path 無し・logsDir 不明は握りつぶさない", () => {
    expect(isVgLogWriteFailure(new TypeError("boom"), logsDir)).toBe(false);
    expect(isVgLogWriteFailure(fsError("EPERM"), logsDir)).toBe(false);
    expect(isVgLogWriteFailure(fsError("ENOENT", "C:/work/logs/anatomia/x.jsonl"), logsDir)).toBe(false);
    expect(isVgLogWriteFailure(fsError("EPERM", "C:/work/logs/anatomia/x.jsonl"), undefined)).toBe(false);
    expect(isVgLogWriteFailure("EPERM", logsDir)).toBe(false);
  });
});
