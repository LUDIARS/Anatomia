import { describe, expect, it } from "vitest";

import { vestigiumDisabledNotice } from "./vestigium.js";

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
