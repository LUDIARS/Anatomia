/**
 * A-3 cache measurement — per-request session context (AsyncLocalStorage).
 *
 * The warm `anatomia web` server is a SINGLE long-running process shared by every
 * terminal/agent session that hits its harness routes. Its cache transcript is
 * built once at boot with one process-global session id (resolveSessionId), so
 * absent any per-request override every cache event is tagged with that one id
 * (e.g. the hook daemon's "hook-daemon"). That makes the GLOBAL hit-rate correct
 * but erases "which session earned this hit".
 *
 * This module threads a per-request session id through the async call tree using
 * AsyncLocalStorage: a route wraps its handler in `runWithSession(id, fn)`, and
 * the instrumented cache reads `currentSession()` at the moment it records a
 * get/llm event. Because the store between request and cache call is all `await`
 * on the same async context, the id propagates without plumbing it through every
 * function signature.
 *
 * SRP: this file ONLY owns the request-scoped session store. The fallback to the
 * process-global id lives at the call site (`currentSession() ?? obs.session`).
 */
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `session` as the request-scoped cache session id. Any cache
 * get/llm event recorded inside (across awaits) reads this id via
 * `currentSession()`. An empty/blank `session` is ignored (no override).
 */
export function runWithSession<T>(session: string | undefined | null, fn: () => T): T {
  const s = typeof session === "string" ? session.trim() : "";
  return s ? storage.run(s, fn) : fn();
}

/** The current request-scoped session id, or undefined when outside a run. */
export function currentSession(): string | undefined {
  return storage.getStore();
}
