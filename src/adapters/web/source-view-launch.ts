/**
 * src/adapters/web/source-view-launch.ts — open a validated target in Tela's
 * dedicated source viewer (`tela_source`).
 *
 * WHERE it opens: on the machine the Anatomia web server runs on, showing that
 * machine's copy of the file. The browser may be elsewhere (Excubitor viewer,
 * a tunnel); a native window on the server host would then appear on a screen
 * the requester cannot see, so the route only launches for a direct local
 * request and otherwise tells the user why (source-view route).
 *
 * WHAT it runs: the viewer and font come from the server's own configuration
 * (`ANATOMIA_TELA_SOURCE_BIN`, `ANATOMIA_TELA_FONT`), never from the request.
 * Both must exist; an unset or missing one is reported as "not configured"
 * rather than guessed. The process starts from an argument array with
 * `shell: false`, so a path with spaces or Japanese characters is one argument
 * and nothing in it is interpreted.
 *
 * SRP: configuration lookup + process start. Path validation lives in
 * source-view-target.ts.
 *
 * @spec Tela source viewer launch
 */

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { stat } from "node:fs/promises";
import type { SourceTarget } from "./source-view-target.js";

export interface SourceViewerConfig {
  bin: string;
  font: string;
  fontSize?: number;
}

export type SourceViewerConfigResult =
  | { ok: true; config: SourceViewerConfig }
  | { ok: false; reason: "not-configured" | "viewer-missing" | "font-missing"; message: string };

const FONT_SIZE_RANGE = { min: 8, max: 48 } as const;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Read the viewer configuration from the server environment and check it exists. */
export async function loadSourceViewerConfig(env: NodeJS.ProcessEnv = process.env): Promise<SourceViewerConfigResult> {
  const bin = env["ANATOMIA_TELA_SOURCE_BIN"]?.trim();
  const font = env["ANATOMIA_TELA_FONT"]?.trim();
  if (!bin || !font) {
    return {
      ok: false,
      reason: "not-configured",
      message: "Tela ソースビューアが未構成です。サーバーに ANATOMIA_TELA_SOURCE_BIN (tela_source の実行ファイル) と ANATOMIA_TELA_FONT (等幅 TrueType フォント) を設定してください。",
    };
  }
  if (!(await isFile(bin))) {
    return { ok: false, reason: "viewer-missing", message: "設定された tela_source が見つかりません。Tela をビルドするか、ANATOMIA_TELA_SOURCE_BIN を確認してください。" };
  }
  if (!(await isFile(font))) {
    return { ok: false, reason: "font-missing", message: "設定されたフォントが見つかりません。ANATOMIA_TELA_FONT を確認してください。" };
  }
  const size = Number(env["ANATOMIA_TELA_FONT_SIZE"]);
  const fontSize = Number.isInteger(size) && size >= FONT_SIZE_RANGE.min && size <= FONT_SIZE_RANGE.max ? size : undefined;
  return { ok: true, config: { bin, font, ...(fontSize !== undefined ? { fontSize } : {}) } };
}

/** The exact argument array passed to `tela_source`. */
export function sourceViewerArgs(config: SourceViewerConfig, target: SourceTarget): string[] {
  return [
    "--font", config.font,
    ...(config.fontSize !== undefined ? ["--font-size", String(config.fontSize)] : []),
    "--source", target.absolutePath,
    "--line", String(target.line),
  ];
}

export type SpawnLike = (command: string, args: string[], options: SpawnOptions) => {
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
};

export type LaunchResult = { ok: true } | { ok: false; reason: "launch-failed"; message: string };

/** Start the viewer detached; resolve once the OS has started (or refused) the process. */
export function launchSourceViewer(
  config: SourceViewerConfig,
  target: SourceTarget,
  spawn: SpawnLike = nodeSpawn as unknown as SpawnLike,
): Promise<LaunchResult> {
  return new Promise((resolveLaunch) => {
    let child: ReturnType<SpawnLike>;
    try {
      child = spawn(config.bin, sourceViewerArgs(config, target), {
        shell: false,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
    } catch (error) {
      resolveLaunch({ ok: false, reason: "launch-failed", message: `ビューアを起動できませんでした: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    child.once("spawn", () => {
      child.unref();
      resolveLaunch({ ok: true });
    });
    child.once("error", (error) => {
      resolveLaunch({ ok: false, reason: "launch-failed", message: `ビューアを起動できませんでした: ${error.message}` });
    });
  });
}
