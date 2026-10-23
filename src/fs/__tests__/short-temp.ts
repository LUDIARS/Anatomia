/**
 * Test support: run a block with TEMP/TMP spelled as an 8.3 short alias.
 *
 * Review hosts hand out a temp dir like `C:/Users/RUNNER~1/AppData/Local/Temp`.
 * `os.tmpdir()` returns that spelling verbatim while realpath and git answer with
 * the long one, so any comparison of the two spellings breaks there and nowhere
 * else. This reproduces it locally: a long-named directory is created under the
 * real temp dir and its short alias becomes TEMP for the duration of `run`.
 *
 * Returns false (and runs nothing) where no alias exists — not Windows, or 8.3
 * name generation disabled on the volume — so callers can skip.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The 8.3 alias of an existing path, or null when it has none. */
export function shortPathAlias(path: string): string | null {
  if (process.platform !== "win32") return null;
  const result = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${path}") do @echo %~sI`], {
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  const out = result.status === 0 ? result.stdout.trim() : "";
  return out !== "" && out.toLowerCase() !== path.toLowerCase() ? out : null;
}

/** Run `run` with TEMP/TMP set to a short alias; false when none is available. */
export async function withShortTemp(run: () => Promise<void>): Promise<boolean> {
  const longDir = await mkdtemp(join(tmpdir(), "anatomia-long-temp-name-"));
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  try {
    const alias = shortPathAlias(longDir);
    if (alias === null) return false;
    process.env.TEMP = alias;
    process.env.TMP = alias;
    await run();
    return true;
  } finally {
    restore("TEMP", saved.TEMP);
    restore("TMP", saved.TMP);
    await rm(longDir, { recursive: true, force: true });
  }
}

function restore(name: "TEMP" | "TMP", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
