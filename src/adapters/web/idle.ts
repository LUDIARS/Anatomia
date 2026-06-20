/**
 * Warm-server idle shutdown.
 *
 * The warm `anatomia web` server is started on demand (the harness hook spawns
 * it on the first supply/verify, i.e. when implementation begins; or a human
 * runs `anatomia web`). To avoid a daemon lingering forever, it shuts itself
 * down after a window with no HTTP access — the next hook call re-spawns it.
 *
 * SRP: pure config + decision helpers. The timer/process.exit wiring lives in
 * server.ts; this file holds the testable logic.
 */

/** Default idle window before self-shutdown: 3 hours. */
export const DEFAULT_IDLE_MS = 3 * 60 * 60 * 1000;

/**
 * Resolve the idle window (ms) from ANATOMIA_IDLE_SHUTDOWN_MS. Unset → default
 * 3h. A value <= 0 (or non-finite) disables idle shutdown (returns 0).
 */
export function resolveIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ANATOMIA_IDLE_SHUTDOWN_MS;
  if (raw === undefined || raw === "") return DEFAULT_IDLE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0; // explicit disable
  return n;
}

/** How often to check for idleness: at most once a minute, never longer than the window. */
export function checkIntervalMs(idleMs: number): number {
  return Math.min(idleMs, 60_000);
}

/** True when the server has been idle for at least `idleMs`. */
export function shouldShutdown(lastAccessMs: number, nowMs: number, idleMs: number): boolean {
  if (idleMs <= 0) return false; // disabled
  return nowMs - lastAccessMs >= idleMs;
}
