import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnalysisCache } from "../cache.js";

/**
 * home が書けない環境 (サンドボックス下の委託 Codex は `~/.anatomia` へ書けず
 * EPERM になる) でも解析を落とさないこと。 キャッシュ書込みの失敗を read 側と
 * 同じく握り潰し、 警告だけ出して続行する。
 */
describe("read-only cache home", () => {
  const homes: string[] = [];
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    warn.mockRestore();
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  it("keeps going when an artifact cannot be persisted and warns once per error code", async () => {
    const home = await mkdtemp(join(tmpdir(), "anatomia-cache-readonly-"));
    homes.push(home);
    // home 直下を "ファイル" にすると、 配下のディレクトリ作成が必ず失敗する
    // (Windows/POSIX とも ENOTDIR 系)。 権限操作より移植性が高い。
    const blockedHome = join(home, "not-a-directory");
    await writeFile(blockedHome, "", "utf8");
    const cache = new AnalysisCache(blockedHome);

    await expect(cache.writeArtifact("project", "domains", "fingerprint", [1, 2])).resolves.toBeUndefined();
    await expect(cache.writeArtifact("project", "graph", "fingerprint", [3])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const warning = String(warn.mock.calls[0]?.[0]);
    expect(warning).toContain("[anatomia/cache]");
    expect(warning).not.toContain(blockedHome);

    // 書けなかったものは当然読めないが、 読み側も例外にはしない。
    await expect(cache.readArtifact("project", "domains", "fingerprint")).resolves.toBeNull();
  });
});
