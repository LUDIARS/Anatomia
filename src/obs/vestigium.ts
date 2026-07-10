/**
 * obs/vestigium — Vestigium (Vg) ログ統合。 Anatomia のキャッシュ/解析イベントを LUDIARS 横断
 * ログ収集 SDK (@ludiars/vestigium) の JSONL へ流す。 Concordia の monitor が同じ logsDir を
 * tail するので、 ここに出したログは横断観測・AI への提供対象になる。
 *
 * 新レイヤ obs の責務: 横断的なログ出力 (どのレイヤからも呼ぶ ambient な観測)。 既存レイヤの
 * いずれにも属さない cross-cutting な関心なので独立させる。
 *
 * 方針:
 *  - **明示 init** (initVestigium): warm web サーバ起動時のみ install する。 CLI 一発実行 / MCP /
 *    test では install しない (writer ストリームが event loop を引き留め短命プロセスを hang させる、
 *    かつ余計なファイル生成を避けるため)。
 *  - vgWrite() は init 前 / 無効時は no-op。 どのレイヤからも安全に呼べる。
 *  - **ctx に機微情報 (token / PII / コード/プロンプトの生データ) を入れない** (Vestigium redact ルール)。
 *    メタデータ (project / ns / hit / pass / gate 名 / 件数) のみ渡す。
 */
import { install, type Vestigium } from "@ludiars/vestigium";

let vg: Vestigium | null = null;
let crashHandlersInstalled = false;
let crashExitScheduled = false;

export interface InitVestigiumOptions {
  captureConsole?: boolean;
}

/** Start Vg once. Tests and ANATOMIA_VESTIGIUM=0 keep it disabled; CLI calls vgShutdown() before exit. */
export function initVestigium(options: InitVestigiumOptions = {}): void {
  if (vg) return;
  if (
    process.env.ANATOMIA_VESTIGIUM === "0" ||
    process.env.NODE_ENV === "test" ||
    process.env.VITEST === "true"
  ) {
    return;
  }
  const captureConsole = options.captureConsole ?? true;
  try {
    vg = install({
      serviceCode: "anatomia",
      captureConsole,
      retentionDays: Number(process.env.VESTIGIUM_RETENTION_DAYS ?? "14") || 14,
    });
  } catch (e) {
    // install 失敗 (権限/パス等) は Vg ログを諦めるが本体は止めない。
    console.error(`[anatomia/vestigium] install failed; Vg ログ無効: ${(e as Error).message}`);
  }
}

export type VgLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** Vg JSONL へ 1 行 emit。 init 前/無効/失敗時は no-op (never throw)。 ctx に機微情報を入れないこと。 */
export function vgWrite(level: VgLevel, msg: string, ctx?: Record<string, unknown>): void {
  try {
    vg?.writer.write({ level, msg, ctx });
  } catch {
    /* never throw from logging */
  }
}

export function vgCrash(kind: string, reason: unknown, ctx?: Record<string, unknown>): void {
  const details = reasonDetails(reason);
  vgWrite("fatal", `[anatomia-crash] ${kind}: ${details.message}`, {
    kind,
    ...ctx,
    ...details,
  });
}

export async function withVgSpan<T>(
  name: string,
  ctx: Record<string, unknown> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  vgWrite("debug", `${name} start`, ctx);
  try {
    const result = await fn();
    vgWrite("debug", `${name} done`, { ...ctx, duration_ms: Date.now() - started });
    return result;
  } catch (err) {
    vgCrash(name, err, { ...ctx, duration_ms: Date.now() - started });
    throw err;
  }
}

export function installCrashLogging(): void {
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;
  if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") return;

  process.on("uncaughtException", (err) => {
    vgCrash("uncaughtException", err);
    console.error("[anatomia-crash] uncaughtException", err);
    scheduleCrashExit(1);
  });
  process.on("unhandledRejection", (reason) => {
    vgCrash("unhandledRejection", reason);
    console.error("[anatomia-crash] unhandledRejection", reason);
    scheduleCrashExit(1);
  });
  process.on("warning", (warning) => {
    vgWrite("warn", "process warning", {
      name: warning.name,
      message: warning.message,
      stack: warning.stack,
    });
  });
  process.on("exit", (code) => {
    if (code !== 0) {
      vgWrite("fatal", `[anatomia-crash] process exit code ${code}`, { kind: "exit", code });
    }
  });
}

export function vgEnabled(): boolean {
  return vg !== null;
}

export async function vgShutdown(): Promise<void> {
  try {
    await vg?.shutdown();
  } catch {
    /* swallow */
  }
  vg = null;
}

function scheduleCrashExit(code: number): void {
  if (crashExitScheduled) return;
  crashExitScheduled = true;
  process.exitCode = code;
  void vgShutdown().finally(() => process.exit(code));
  const timer = setTimeout(() => process.exit(code), 1000);
  timer.unref?.();
}

function reasonDetails(reason: unknown): Record<string, unknown> & { message: string } {
  if (reason instanceof Error) {
    return {
      name: reason.name,
      message: reason.message,
      stack: reason.stack,
    };
  }
  if (typeof reason === "string") {
    return { message: reason };
  }
  try {
    return { message: JSON.stringify(reason) ?? String(reason) };
  } catch {
    return { message: String(reason) };
  }
}
