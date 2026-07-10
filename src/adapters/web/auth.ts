/**
 * src/adapters/web/auth.ts — Bearer-token gate for the panel's mutation routes.
 *
 * The web panel exposes mutation routes (POST /api/projects, DELETE
 * /api/projects/:id, POST /api/projects/:id/analyze, ...) that enqueue
 * LLM-billed analysis work. Auth is opt-in via ANATOMIA_WEB_TOKEN:
 *
 *   - Token set   → every mutation request (POST/PUT/PATCH/DELETE) must carry
 *                   `Authorization: Bearer <token>`; a mismatch is 401.
 *                   Read routes (GET/HEAD/OPTIONS) stay open — the panel is
 *                   still browsable without a token.
 *   - Token unset → nothing is gated, but binding a NON-loopback address is
 *                   refused at startup (fail-fast, no silent fallback —
 *                   RULE_CODE §7/§9): unauthenticated mutation routes must not
 *                   be reachable from other machines.
 *
 * Token comparison is timing-safe (crypto.timingSafeEqual over sha256 digests,
 * so unequal lengths never short-circuit).
 *
 * SRP: auth policy only. Wiring lives in server.ts.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/** HTTP methods gated by the mutation auth middleware. */
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Resolve the panel auth token from ANATOMIA_WEB_TOKEN.
 * Unset / blank → undefined (auth disabled, loopback-only enforcement applies).
 */
export function resolveWebToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.ANATOMIA_WEB_TOKEN;
  if (raw === undefined) return undefined;
  const token = raw.trim();
  return token === "" ? undefined : token;
}

/**
 * True when `hostname` is a loopback bind address (127.0.0.0/8, localhost,
 * IPv6 ::1 — including the bracketed and IPv4-mapped spellings).
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  if (h.startsWith("127.")) return true;
  if (h.startsWith("::ffff:127.")) return true; // IPv4-mapped IPv6 loopback
  return false;
}

/**
 * Fail fast when the server would expose unauthenticated mutation routes:
 * binding a non-loopback address without ANATOMIA_WEB_TOKEN throws a startup
 * error (never a silent downgrade to "warn and serve anyway").
 */
export function assertBindAllowed(hostname: string, token: string | undefined): void {
  if (token !== undefined || isLoopbackHost(hostname)) return;
  throw new Error(
    `anatomia web: refusing to bind non-loopback address "${hostname}" without ANATOMIA_WEB_TOKEN. ` +
      `Mutation routes (POST/DELETE, incl. LLM-billed analyze jobs) would be reachable unauthenticated. ` +
      `Set ANATOMIA_WEB_TOKEN=<secret> (clients then send "Authorization: Bearer <secret>") ` +
      `or bind a loopback address (default 127.0.0.1).`,
  );
}

/**
 * Hono middleware gating mutation methods behind `Authorization: Bearer <token>`.
 * Register only when a token is configured; read methods always pass through.
 */
export function mutationAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (!MUTATION_METHODS.has(c.req.method.toUpperCase())) return next();
    const presented = bearerFrom(c.req.header("authorization"));
    if (presented === undefined || !tokensMatch(presented, token)) {
      return c.json(
        { error: "unauthorized: mutation routes require Authorization: Bearer <ANATOMIA_WEB_TOKEN>" },
        401,
      );
    }
    return next();
  };
}

/** Extract the credential from a `Bearer <token>` header value (else undefined). */
function bearerFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
}

/**
 * Timing-safe equality. Comparing fixed-length sha256 digests keeps
 * timingSafeEqual's equal-length precondition satisfied without leaking the
 * expected token's length via an early return.
 */
function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
